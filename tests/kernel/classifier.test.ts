import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultRegistry } from "@agents/registry";
import {
  classifyTask,
  keywordClassifier,
  keywordClassify,
  measureAccuracy,
  scoreAgents,
  type LabelledTask,
} from "@kernel/classifier";
import type { LlmClient, LlmRequest, LlmResponse } from "@llm/types";
import type { Task } from "@kernel/schemas";

const registry = defaultRegistry();

const task = (id: string, description: string, agentHint?: string): Task => ({
  id,
  description,
  dependsOn: [],
  status: "pending",
  attempts: 0,
  ...(agentHint === undefined ? {} : { agentHint }),
});

/** Returns a canned classifier answer and records what it was asked. */
class StubLlm implements LlmClient {
  readonly name = "stub";
  readonly requests: LlmRequest[] = [];

  constructor(private readonly reply: string) {}

  generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return Promise.resolve({ text: this.reply, tokensIn: 10, tokensOut: 5 });
  }
}

class ThrowingLlm implements LlmClient {
  readonly name = "throwing";
  generate(): Promise<LlmResponse> {
    return Promise.reject(new Error("model unavailable"));
  }
}

const labelled: LabelledTask[] = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures", "classifier", "labelled-tasks.json"), "utf8"),
) as LabelledTask[];

/* -------------------------------------------------------------------------- */

describe("scoreAgents", () => {
  it("matches whole words only", () => {
    // "postcode" must not fire the publish agent's "post" cue.
    const scores = scoreAgents(task("t", "Validate the postcode field."), registry);

    expect(scores.get("publish")).toBe(0);
  });

  it("does not fire 'add' on 'address'", () => {
    const scores = scoreAgents(task("t", "Read the address book."), registry);

    expect(scores.get("compute")).toBe(0);
  });

  it("matches multi-word cues as phrases", () => {
    const scores = scoreAgents(task("t", "Look up the supplier."), registry);

    expect(scores.get("research")).toBeGreaterThan(0);
  });

  it("also scores against the task id", () => {
    // Descriptions are sometimes terse; the id carries signal too.
    const scores = scoreAgents(task("send_email", "Do the thing."), registry);

    expect(scores.get("publish")).toBeGreaterThan(0);
  });
});

describe("keywordClassify", () => {
  it("routes a fetch task to research", () => {
    expect(keywordClassify(task("t", "Fetch the front page."), registry).agent).toBe(
      "research",
    );
  });

  it("routes an arithmetic task to compute", () => {
    expect(keywordClassify(task("t", "Add the two numbers."), registry).agent).toBe("compute");
  });

  it("routes a posting task to publish", () => {
    expect(keywordClassify(task("t", "Post the tweet to Twitter."), registry).agent).toBe(
      "publish",
    );
  });

  it("reports zero confidence and a reason when nothing matches", () => {
    const result = keywordClassify(task("t", "Handle the thing appropriately."), registry);

    expect(result.confidence).toBe(0);
    expect(result.reason).toContain("no keyword matched");
    // Still returns a usable agent rather than nothing.
    expect(registry.has(result.agent)).toBe(true);
  });

  it("reports confidence as the winner's share of all matches", () => {
    const result = keywordClassify(task("t", "Fetch and search the archive."), registry);

    expect(result.confidence).toBe(1);
  });

  it("breaks ties by registry order, not Map iteration order", () => {
    const result = keywordClassify(task("t", "Check that the post arrived."), registry);

    // research and publish both score 1; research is registered first.
    expect(result.agent).toBe("research");
  });

  it("is deterministic", () => {
    const subject = task("t", "Summarise the article and post it.");

    expect(keywordClassify(subject, registry)).toEqual(keywordClassify(subject, registry));
  });
});

describe("classifyTask — hint path", () => {
  it("trusts a hint naming a registered agent", async () => {
    const result = await classifyTask(task("t", "Do something", "publish"), { registry });

    expect(result).toMatchObject({ agent: "publish", source: "hint", confidence: 1 });
  });

  it("ignores a hint naming an unregistered agent", async () => {
    const result = await classifyTask(task("t", "Fetch the page", "wizard"), { registry });

    expect(result.agent).toBe("research");
    expect(result.source).toBe("keyword");
  });

  it("can be told to ignore hints entirely", async () => {
    const result = await classifyTask(task("t", "Fetch the page", "publish"), {
      registry,
      useHint: false,
    });

    expect(result.source).toBe("keyword");
    expect(result.agent).toBe("research");
  });

  it("never consults the model when a valid hint is present", async () => {
    const llm = new StubLlm('{"agent":"compute"}');

    await classifyTask(task("t", "Do something", "publish"), { registry, llm });

    expect(llm.requests).toHaveLength(0);
  });
});

describe("classifyTask — llm path", () => {
  it("uses a valid model answer", async () => {
    const llm = new StubLlm('{"agent":"compute","reason":"it transforms data"}');

    const result = await classifyTask(task("t", "Fetch the page"), { registry, llm });

    expect(result).toMatchObject({
      agent: "compute",
      source: "llm",
      reason: "it transforms data",
    });
  });

  it("sends the registry and the task in the prompt", async () => {
    const llm = new StubLlm('{"agent":"research"}');

    await classifyTask(task("fetch_it", "Fetch the page"), { registry, llm });

    const prompt = llm.requests[0]?.prompt ?? "";
    expect(prompt).toContain("research");
    expect(prompt).toContain("fetch_it");
    expect(llm.requests[0]?.json).toBe(true);
    expect(llm.requests[0]?.temperature).toBe(0);
  });

  it("discards an answer naming an agent that does not exist", async () => {
    const llm = new StubLlm('{"agent":"wizard","reason":"magic"}');

    const result = await classifyTask(task("t", "Fetch the page"), { registry, llm });

    // A classifier that can invent a destination is worse than one that is
    // occasionally wrong: the orchestrator would dispatch into nothing.
    expect(result.agent).toBe("research");
    expect(result.source).toBe("keyword");
    expect(result.reason).toContain("model answer unusable");
  });

  it("falls back when the model returns unparseable output", async () => {
    const llm = new StubLlm("I'm not sure, maybe research?");

    const result = await classifyTask(task("t", "Post the tweet"), { registry, llm });

    expect(result.source).toBe("keyword");
    expect(result.agent).toBe("publish");
  });

  it("falls back when the model call throws", async () => {
    const result = await classifyTask(task("t", "Post the tweet"), {
      registry,
      llm: new ThrowingLlm(),
    });

    // An unavailable classifier must not stop a run that can still proceed.
    expect(result.source).toBe("keyword");
    expect(result.agent).toBe("publish");
  });

  it("tolerates surrounding prose around the JSON", async () => {
    const llm = new StubLlm('Sure!\n```json\n{"agent":"publish"}\n```');

    const result = await classifyTask(task("t", "Do something"), { registry, llm });

    expect(result).toMatchObject({ agent: "publish", source: "llm" });
  });
});

describe("keywordClassifier adapter", () => {
  it("returns a plain agent name for the orchestrator", () => {
    const classify = keywordClassifier(registry);

    expect(classify(task("t", "Post the tweet"))).toBe("publish");
  });

  it("honours a valid hint", () => {
    expect(keywordClassifier(registry)(task("t", "Fetch it", "compute"))).toBe("compute");
  });

  it("can be built to ignore hints", () => {
    expect(keywordClassifier(registry, false)(task("t", "Fetch it", "compute"))).toBe(
      "research",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("classifier accuracy on the labelled set", () => {
  it("has 20 labelled tasks covering every agent", () => {
    expect(labelled).toHaveLength(20);

    const byAgent = new Set(labelled.map((t) => t.expected));
    expect([...byAgent].sort()).toEqual(["compute", "publish", "research"]);
  });

  it("labels only registered agents", () => {
    for (const item of labelled) {
      expect(registry.has(item.expected), item.id).toBe(true);
    }
  });

  it("routes at least 85% correctly with keywords alone", async () => {
    const report = await measureAccuracy(labelled, { registry, useHint: false });

    // Deterministic, so this is a real regression gate rather than a flaky one.
    expect(report.accuracy).toBeGreaterThanOrEqual(0.85);
    expect(report.total).toBe(20);
  });

  it("misroutes only the two known adversarial cases", async () => {
    const report = await measureAccuracy(labelled, { registry, useHint: false });

    // The set deliberately contains tasks whose surface vocabulary points the
    // wrong way. Naming them keeps the score honest: a change that "fixes"
    // these by over-fitting keywords should have to edit this expectation.
    expect(report.misroutes.map((m) => m.id).sort()).toEqual([
      "extract_publish_date",
      "post_process_results",
    ]);
  });

  it("achieves non-zero recall for every agent", async () => {
    const report = await measureAccuracy(labelled, { registry, useHint: false });

    for (const [agent, stats] of Object.entries(report.byAgent)) {
      // One weak class must not hide inside a healthy average.
      expect(stats.correct, `${agent} recall`).toBeGreaterThan(0);
    }
  });

  it("reaches 100% when a perfect model routes", async () => {
    // Bounds the harness itself: with an oracle classifier the measurement
    // must report 20/20, so a low score means routing, not the scorer.
    const oracle: LlmClient = {
      name: "oracle",
      generate: (request) => {
        const id = /id: (\S+)/.exec(request.prompt)?.[1] ?? "";
        const expected = labelled.find((t) => t.id === id)?.expected ?? "research";
        return Promise.resolve({
          text: JSON.stringify({ agent: expected }),
          tokensIn: 0,
          tokensOut: 0,
        });
      },
    };

    const report = await measureAccuracy(labelled, { registry, llm: oracle, useHint: false });

    expect(report.accuracy).toBe(1);
    expect(report.misroutes).toEqual([]);
  });

  it("reports per-agent totals that sum to the whole set", async () => {
    const report = await measureAccuracy(labelled, { registry, useHint: false });
    const total = Object.values(report.byAgent).reduce((sum, s) => sum + s.total, 0);

    expect(total).toBe(20);
    expect(report.correct + report.misroutes.length).toBe(20);
  });

  it("returns zero accuracy for an empty set rather than dividing by zero", async () => {
    const report = await measureAccuracy([], { registry });

    expect(report.accuracy).toBe(0);
  });
});
