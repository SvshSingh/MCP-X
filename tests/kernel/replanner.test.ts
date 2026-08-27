import { describe, expect, it } from "vitest";

import { deriveState, taskState } from "@kernel/blackboard";
import { runPlan } from "@kernel/orchestrator";
import {
  carriedForward,
  createReplan,
  DEFAULT_MAX_REPLANS,
  llmReplanner,
  ReplanError,
  REPLANNER_SYSTEM_PROMPT,
  validateRevision,
  type ReplanContext,
} from "@kernel/replanner";
import { Plan, type Event, type Task } from "@kernel/schemas";
import type { LlmClient, LlmRequest, LlmResponse } from "@llm/types";

const AT = "2026-08-27T10:00:00.000Z";
const now = () => new Date(AT);

const planOf = (
  tasks: { id: string; dependsOn?: string[] }[],
  revision = 0,
): Plan =>
  Plan.parse({
    goal: "ship the thing",
    tasks: tasks.map((t) => ({
      id: t.id,
      description: `do ${t.id}`,
      dependsOn: t.dependsOn ?? [],
    })),
    createdAt: AT,
    revision,
  });

/** root -> risky -> report */
const original = planOf([
  { id: "root" },
  { id: "risky", dependsOn: ["root"] },
  { id: "report", dependsOn: ["risky"] },
]);

const completed = (taskId: string): Event => ({
  type: "task_completed",
  runId: "run-1",
  at: AT,
  taskId,
  result: { taskId, ok: true, output: `${taskId} ok`, toolCalls: [], tokensIn: 0, tokensOut: 0 },
});

const failed = (taskId: string): Event => ({
  type: "task_failed",
  runId: "run-1",
  at: AT,
  taskId,
  error: "tool is broken",
  attempt: 1,
  willRetry: false,
});

const contextAfterFailure = (): ReplanContext => ({
  goal: "ship the thing",
  plan: original,
  state: deriveState(original, [completed("root"), failed("risky")]),
  failedTaskId: "risky",
  error: "tool is broken",
});

class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  readonly requests: LlmRequest[] = [];
  #index = 0;

  constructor(private readonly script: readonly string[]) {}

  generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.script[Math.min(this.#index, this.script.length - 1)] ?? "";
    this.#index++;
    return Promise.resolve({ text, tokensIn: 60, tokensOut: 30 });
  }
}

const revisionJson = (
  tasks: { id: string; dependsOn?: string[] }[],
  reason = "use a different source",
) =>
  JSON.stringify({
    reason,
    tasks: tasks.map((t) => ({
      id: t.id,
      description: `do ${t.id}`,
      dependsOn: t.dependsOn ?? [],
    })),
  });

/** Keeps `root`, drops `risky`, routes around it. */
const goodRevision = revisionJson([
  { id: "root" },
  { id: "alternate_source", dependsOn: ["root"] },
  { id: "report_v2", dependsOn: ["alternate_source"] },
]);

/* -------------------------------------------------------------------------- */

describe("carriedForward", () => {
  it("returns only the completed tasks", () => {
    const context = contextAfterFailure();

    expect(carriedForward(context.plan, context.state).map((t) => t.id)).toEqual(["root"]);
  });
});

describe("validateRevision", () => {
  const context = contextAfterFailure();

  it("accepts a revision that keeps completed work and routes around the failure", () => {
    const next = planOf(
      [{ id: "root" }, { id: "alternate", dependsOn: ["root"] }],
      1,
    );

    expect(validateRevision(next, context)).toEqual([]);
  });

  it("rejects a revision that drops completed work", () => {
    const next = planOf([{ id: "alternate" }], 1);

    // State is derived by replaying events over the current plan, so dropping
    // a completed id silently discards its result and redoes the work.
    expect(validateRevision(next, context).join(" ")).toContain('"root"');
  });

  it("rejects a revision that reuses the failed task id", () => {
    const next = planOf([{ id: "root" }, { id: "risky", dependsOn: ["root"] }], 1);

    // The task_failed event is still in the log and would be replayed against
    // the new plan, so the "alternate" path could never run.
    expect(validateRevision(next, context).join(" ")).toContain('"risky"');
  });

  it("rejects a revision that does not advance the revision number", () => {
    const next = planOf([{ id: "root" }, { id: "alternate", dependsOn: ["root"] }], 0);

    expect(validateRevision(next, context).join(" ")).toContain("revision must be 1");
  });

  it("rejects a revision that adds no new work", () => {
    const next = planOf([{ id: "root" }], 1);

    expect(validateRevision(next, context).join(" ")).toContain("adds no new work");
  });
});

/* -------------------------------------------------------------------------- */

describe("createReplan", () => {
  it("produces a revision that keeps completed work and drops the failure", async () => {
    const llm = new ScriptedLlm([goodRevision]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.plan.revision).toBe(1);
    expect(result.plan.tasks.map((t) => t.id)).toEqual([
      "root",
      "alternate_source",
      "report_v2",
    ]);
    expect(result.reason).toBe("use a different source");
  });

  it("tells the model what completed, what failed and why", async () => {
    const llm = new ScriptedLlm([goodRevision]);

    await createReplan(contextAfterFailure(), { llm, now });

    const prompt = llm.requests[0]?.prompt ?? "";
    expect(prompt).toContain("root");
    expect(prompt).toContain("risky");
    expect(prompt).toContain("tool is broken");
    expect(llm.requests[0]?.system).toBe(REPLANNER_SYSTEM_PROMPT);
  });

  it("retries with the specific problem when the model reuses the failed id", async () => {
    const bad = revisionJson([{ id: "root" }, { id: "risky", dependsOn: ["root"] }]);
    const llm = new ScriptedLlm([bad, goodRevision]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.errors.join(" ")).toContain("different id");
    expect(llm.requests[1]?.prompt).toContain("must not appear again");
  });

  it("retries when the model drops completed work", async () => {
    const bad = revisionJson([{ id: "fresh_start" }]);
    const llm = new ScriptedLlm([bad, goodRevision]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.attempts[0]?.errors.join(" ")).toContain("must be kept");
    expect(result.plan.tasks.map((t) => t.id)).toContain("root");
  });

  it("retries when the revision is a cyclic graph", async () => {
    const cyclic = revisionJson([
      { id: "root" },
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ]);
    const llm = new ScriptedLlm([cyclic, goodRevision]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.attempts[0]?.errors.join(" ")).toContain("cycle");
    expect(result.attempts).toHaveLength(2);
  });

  it("recovers when the model returns prose", async () => {
    const llm = new ScriptedLlm(["I cannot fix that.", goodRevision]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.attempts[0]?.errors[0]).toContain("not valid JSON");
    expect(result.plan.revision).toBe(1);
  });

  it("gives up after the attempt cap", async () => {
    const llm = new ScriptedLlm(["nonsense"]);

    await expect(createReplan(contextAfterFailure(), { llm, now })).rejects.toThrow(
      ReplanError,
    );
    expect(llm.requests).toHaveLength(3);
  });

  it("supplies a default reason when the model omits one", async () => {
    const llm = new ScriptedLlm([
      JSON.stringify({
        tasks: [
          { id: "root", description: "do root", dependsOn: [] },
          { id: "alt", description: "do alt", dependsOn: ["root"] },
        ],
      }),
    ]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.reason).toContain("risky");
  });

  it("sums tokens across attempts", async () => {
    const llm = new ScriptedLlm([revisionJson([{ id: "root" }]), goodRevision]);

    const result = await createReplan(contextAfterFailure(), { llm, now });

    expect(result.tokensIn).toBe(120);
    expect(result.tokensOut).toBe(60);
  });
});

/* -------------------------------------------------------------------------- */

describe("runPlan — bounded replanning", () => {
  /** Fails `risky`, succeeds at everything else. */
  const brokenTool = (task: Task) =>
    task.id === "risky"
      ? { taskId: task.id, ok: false as const, error: "tool is broken" }
      : { taskId: task.id, ok: true as const, output: `${task.id} ok` };

  const staticReplanner = (next: Plan, reason = "route around the broken tool") => {
    let calls = 0;
    return {
      calls: () => calls,
      fn: () => {
        calls++;
        return Promise.resolve({ plan: next, reason });
      },
    };
  };

  // The Phase 6 acceptance criterion.
  it("a broken tool triggers exactly one replan and the run completes", async () => {
    const alternate = planOf(
      [{ id: "root" }, { id: "alternate", dependsOn: ["root"] }, { id: "report_v2", dependsOn: ["alternate"] }],
      1,
    );
    const replanner = staticReplanner(alternate);

    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
      replan: replanner.fn,
    });

    expect(replanner.calls()).toBe(1);
    expect(outcome.ok).toBe(true);
    expect(taskState(outcome.state, "alternate").status).toBe("completed");
    expect(taskState(outcome.state, "report_v2").status).toBe("completed");
  });

  it("shows both plan revisions in the run record", async () => {
    const alternate = planOf([{ id: "root" }, { id: "alternate", dependsOn: ["root"] }], 1);

    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
      replan: staticReplanner(alternate).fn,
    });

    expect(outcome.record.planRevisions).toHaveLength(2);
    expect(outcome.record.planRevisions[0]?.revision).toBe(0);
    expect(outcome.record.planRevisions[1]?.revision).toBe(1);
    // Appended, not mutated: the original is still there exactly as planned.
    expect(outcome.record.planRevisions[0]?.tasks.map((t) => t.id)).toEqual([
      "root",
      "risky",
      "report",
    ]);
  });

  it("emits a replan event naming the trigger and the reason", async () => {
    const alternate = planOf([{ id: "root" }, { id: "alternate", dependsOn: ["root"] }], 1);

    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
      replan: staticReplanner(alternate, "the source API is down").fn,
    });

    const replan = outcome.record.events.find((e) => e.type === "replan");
    expect(replan).toMatchObject({
      fromRevision: 0,
      toRevision: 1,
      reason: "the source API is down",
      triggeredByTaskId: "risky",
    });
  });

  it("does not re-run work that already completed", async () => {
    const alternate = planOf([{ id: "root" }, { id: "alternate", dependsOn: ["root"] }], 1);
    const ran: string[] = [];

    await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: (task) => {
        ran.push(task.id);
        return brokenTool(task);
      },
      replan: staticReplanner(alternate).fn,
    });

    // "root" completed before the failure and must not be executed again.
    expect(ran.filter((id) => id === "root")).toHaveLength(1);
  });

  it("respects the replan cap", async () => {
    // Every revision keeps failing, so the cap is what stops the run.
    let revision = 0;
    let calls = 0;

    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      maxReplans: 2,
      execute: (task) =>
        task.id === "root"
          ? { taskId: task.id, ok: true, output: "ok" }
          : { taskId: task.id, ok: false, error: "still broken" },
      replan: () => {
        calls++;
        revision++;
        return Promise.resolve({
          plan: planOf([{ id: "root" }, { id: `attempt_${revision}`, dependsOn: ["root"] }], revision),
          reason: `attempt ${revision}`,
        });
      },
    });

    expect(calls).toBe(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.record.planRevisions).toHaveLength(3);
  });

  it("defaults the cap to two", () => {
    expect(DEFAULT_MAX_REPLANS).toBe(2);
  });

  it("does not replan when no replanner is supplied", async () => {
    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.record.planRevisions).toHaveLength(1);
    expect(outcome.record.events.some((e) => e.type === "replan")).toBe(false);
  });

  it("does not replan a run that succeeded", async () => {
    const replanner = staticReplanner(planOf([{ id: "root" }], 1));

    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok" }),
      replan: replanner.fn,
    });

    expect(replanner.calls()).toBe(0);
    expect(outcome.ok).toBe(true);
  });

  it("reports a replanner that throws rather than swallowing it", async () => {
    const seen: unknown[] = [];

    await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
      replan: () => Promise.reject(new Error("replanner unavailable")),
      onReplanError: (error) => seen.push(error),
    });

    // Silence here is indistinguishable from having no replanner configured,
    // which is exactly the wrong thing to have to debug blind.
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("replanner unavailable");
  });

  it("ends the run cleanly when the replanner itself fails", async () => {
    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
      replan: () => Promise.reject(new Error("replanner unavailable")),
    });

    // A replanner that cannot produce a route is not a crash; the run ends
    // with the failure it already had.
    expect(outcome.ok).toBe(false);
    expect(taskState(outcome.state, "risky").status).toBe("failed");
    expect(outcome.record.planRevisions).toHaveLength(1);
  });

  it("produces a schema-valid record across revisions", async () => {
    const alternate = planOf([{ id: "root" }, { id: "alternate", dependsOn: ["root"] }], 1);

    const outcome = await runPlan({
      plan: original,
      runId: "run-1",
      now,
      maxAttemptsPerTask: 1,
      execute: brokenTool,
      replan: staticReplanner(alternate).fn,
    });

    // RunRecord requires contiguous revisions from 0 and one shared goal.
    expect(outcome.record.planRevisions.map((p) => p.revision)).toEqual([0, 1]);
  });
});

describe("llmReplanner adapter", () => {
  it("returns just the plan and reason", async () => {
    const replan = llmReplanner({ llm: new ScriptedLlm([goodRevision]), now });

    const result = await replan(contextAfterFailure());

    expect(result.plan.revision).toBe(1);
    expect(result.reason).toBe("use a different source");
  });
});
