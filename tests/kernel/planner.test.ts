import { describe, expect, it } from "vitest";

import { FixtureLlmClient, loadFixtures } from "@llm/fixture";
import type { LlmClient, LlmRequest, LlmResponse } from "@llm/types";
import {
  createPlan,
  PlannerError,
  PLANNER_SYSTEM_PROMPT,
  DEFAULT_MAX_PLAN_ATTEMPTS,
} from "@kernel/planner";
import { findCycle } from "@kernel/schemas";

const AT = new Date("2026-08-27T10:00:00.000Z");
const now = () => AT;

/** Replays a scripted list of completions and records what it was asked. */
class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  readonly requests: LlmRequest[] = [];
  #index = 0;

  constructor(private readonly script: readonly string[]) {}

  generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.script[Math.min(this.#index, this.script.length - 1)] ?? "";
    this.#index++;
    return Promise.resolve({ text, tokensIn: 100, tokensOut: 50 });
  }
}

const tasksJson = (tasks: unknown) => JSON.stringify({ tasks });

const validTasks = [
  { id: "a", description: "do a", dependsOn: [] },
  { id: "b", description: "do b", dependsOn: ["a"] },
  { id: "c", description: "do c", dependsOn: ["a"] },
];

/* -------------------------------------------------------------------------- */

describe("createPlan", () => {
  it("turns a goal into a validated plan on the first attempt", async () => {
    const llm = new ScriptedLlm([tasksJson(validTasks)]);

    const result = await createPlan("ship the thing", { llm, now });

    expect(result.plan.goal).toBe("ship the thing");
    expect(result.plan.revision).toBe(0);
    expect(result.plan.createdAt).toBe(AT.toISOString());
    expect(result.plan.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result.attempts).toHaveLength(1);
  });

  it("applies Task defaults to what the model omits", async () => {
    const llm = new ScriptedLlm([tasksJson([{ id: "a", description: "do a" }])]);

    const result = await createPlan("goal", { llm, now });

    expect(result.plan.tasks[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      dependsOn: [],
    });
  });

  it("sends the planning system prompt and asks for JSON at temperature 0", async () => {
    const llm = new ScriptedLlm([tasksJson(validTasks)]);

    await createPlan("ship the thing", { llm, now });

    const request = llm.requests[0];
    expect(request?.system).toBe(PLANNER_SYSTEM_PROMPT);
    expect(request?.json).toBe(true);
    // Planning wants the most probable decomposition, not a creative one.
    expect(request?.temperature).toBe(0);
    expect(request?.prompt).toContain("ship the thing");
  });

  it("trims the goal before planning", async () => {
    const llm = new ScriptedLlm([tasksJson(validTasks)]);

    const result = await createPlan("   ship the thing   ", { llm, now });

    expect(result.plan.goal).toBe("ship the thing");
  });

  it("sums tokens across every attempt, not just the successful one", async () => {
    const llm = new ScriptedLlm([tasksJson([]), tasksJson(validTasks)]);

    const result = await createPlan("goal", { llm, now });

    // Two calls at 100 in / 50 out each.
    expect(result.tokensIn).toBe(200);
    expect(result.tokensOut).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */

describe("createPlan — schema repair loop", () => {
  it("retries with the validation errors when the DAG has a cycle", async () => {
    const cyclic = [
      { id: "a", description: "do a", dependsOn: ["b"] },
      { id: "b", description: "do b", dependsOn: ["a"] },
    ];
    const llm = new ScriptedLlm([tasksJson(cyclic), tasksJson(validTasks)]);

    const result = await createPlan("goal", { llm, now });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.errors.some((e) => e.includes("dependency cycle"))).toBe(true);
    expect(findCycle(result.plan.tasks)).toBeNull();
  });

  it("feeds the rejected output and the reasons back to the model", async () => {
    const bad = tasksJson([{ id: "a", description: "do a", dependsOn: ["ghost"] }]);
    const llm = new ScriptedLlm([bad, tasksJson(validTasks)]);

    await createPlan("goal", { llm, now });

    const repair = llm.requests[1]?.prompt ?? "";
    // A bare "try again" tends to reproduce the same output, so the repair
    // prompt must carry both what was produced and what was wrong with it.
    expect(repair).toContain("ghost");
    expect(repair).toContain("unknown task");
    expect(repair).toContain(bad);
  });

  it("reports every structural defect in a single repair round-trip", async () => {
    const messy = tasksJson([
      { id: "a", description: "do a", dependsOn: ["ghost"] },
      { id: "a", description: "duplicate", dependsOn: [] },
      { id: "b", description: "do b", dependsOn: ["c"] },
      { id: "c", description: "do c", dependsOn: ["b"] },
    ]);
    const llm = new ScriptedLlm([messy, tasksJson(validTasks)]);

    const result = await createPlan("goal", { llm, now });
    const errors = result.attempts[0]?.errors ?? [];

    // This is the payoff for Plan collecting all issues rather than
    // short-circuiting: one retry can fix everything.
    expect(errors.some((e) => e.includes("duplicate task id"))).toBe(true);
    expect(errors.some((e) => e.includes("unknown task"))).toBe(true);
    expect(errors.some((e) => e.includes("dependency cycle"))).toBe(true);
    expect(result.attempts).toHaveLength(2);
  });

  it("recovers when the model returns prose instead of JSON", async () => {
    const llm = new ScriptedLlm(["I cannot do that.", tasksJson(validTasks)]);

    const result = await createPlan("goal", { llm, now });

    expect(result.attempts[0]?.errors[0]).toContain("not valid JSON");
    expect(result.plan.tasks).toHaveLength(3);
  });

  it("gives up after the attempt cap and reports the last errors", async () => {
    const llm = new ScriptedLlm(["not json at all"]);

    await expect(createPlan("goal", { llm, now })).rejects.toThrow(PlannerError);
  });

  it("makes exactly maxAttempts calls before failing", async () => {
    const llm = new ScriptedLlm(["nope"]);

    await createPlan("goal", { llm, now, maxAttempts: 2 }).catch(() => undefined);

    expect(llm.requests).toHaveLength(2);
  });

  it("defaults to three attempts", async () => {
    const llm = new ScriptedLlm(["nope"]);

    await createPlan("goal", { llm, now }).catch(() => undefined);

    expect(llm.requests).toHaveLength(DEFAULT_MAX_PLAN_ATTEMPTS);
  });

  it("carries every attempt and its token cost on the error", async () => {
    const llm = new ScriptedLlm(["nope"]);

    try {
      await createPlan("goal", { llm, now, maxAttempts: 2 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PlannerError);
      const planner = error as PlannerError;
      // A failed planning run still cost money; the record must show it.
      expect(planner.attempts).toHaveLength(2);
      expect(planner.tokensIn).toBe(200);
      expect(planner.tokensOut).toBe(100);
    }
  });

  it("rejects an empty goal without calling the model", async () => {
    const llm = new ScriptedLlm([tasksJson(validTasks)]);

    await expect(createPlan("   ", { llm, now })).rejects.toThrow(PlannerError);
    expect(llm.requests).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("createPlan — against recorded fixtures", () => {
  const fixtures = loadFixtures();

  // The Phase 2 acceptance criterion.
  it("decomposes the HN-to-Twitter goal into >=3 correctly ordered tasks", async () => {
    const llm = new FixtureLlmClient(fixtures);
    const goal = "post a summary of today's top HN story to Twitter";

    const { plan } = await createPlan(goal, { llm, now });

    expect(plan.tasks.length).toBeGreaterThanOrEqual(3);
    expect(findCycle(plan.tasks)).toBeNull();

    const byId = new Map(plan.tasks.map((t) => [t.id, t]));

    // Every dependency resolves (Plan guarantees it, but assert the shape we
    // actually care about rather than trusting the schema alone).
    for (const task of plan.tasks) {
      for (const dep of task.dependsOn) expect(byId.has(dep)).toBe(true);
    }

    // The publish step must come last, and must transitively depend on the
    // fetch step -- that ordering is the whole point of the plan.
    const publish = plan.tasks.find((t) => t.agentHint === "publish");
    expect(publish).toBeDefined();
    expect(plan.tasks.some((t) => t.dependsOn.includes(publish!.id))).toBe(false);

    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (byId.get(from)?.dependsOn ?? []).some((d) => reaches(d, target, seen));
    };

    const root = plan.tasks.find((t) => t.dependsOn.length === 0);
    expect(root).toBeDefined();
    expect(reaches(publish!.id, root!.id)).toBe(true);
  });

  it("exposes a parallel branch for the scheduler to exploit", async () => {
    const llm = new FixtureLlmClient(fixtures);

    const { plan } = await createPlan(
      "post a summary of today's top HN story to Twitter",
      { llm, now },
    );

    // At least two tasks share a dependency set and do not depend on each
    // other -- Phase 3 dispatches these concurrently.
    const siblings = plan.tasks.filter(
      (t) => t.dependsOn.length === 1 && t.dependsOn[0] === plan.tasks[0]?.id,
    );

    expect(siblings.length).toBeGreaterThanOrEqual(2);
  });

  it("repairs a recorded cyclic plan on the second attempt", async () => {
    const llm = new FixtureLlmClient(fixtures);

    const result = await createPlan("restock the warehouse for next week", { llm, now });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.errors.some((e) => e.includes("dependency cycle"))).toBe(true);
    expect(findCycle(result.plan.tasks)).toBeNull();
    expect(result.plan.tasks).toHaveLength(3);
  });

  it("handles a recorded fence-wrapped, prose-padded response", async () => {
    const llm = new FixtureLlmClient(fixtures);

    const result = await createPlan("add 2 and 3 and tell me the answer", { llm, now });

    expect(result.attempts).toHaveLength(1);
    expect(result.plan.tasks.map((t) => t.id)).toEqual(["add_numbers", "report_result"]);
  });
});
