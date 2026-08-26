import { describe, expect, it } from "vitest";

import {
  AgentResult,
  Event,
  findCycle,
  findDuplicateIds,
  findUnresolvedDependencies,
  isTerminal,
  Plan,
  RunRecord,
  Task,
  TaskStatus,
  TokenUsage,
  type PlanInput,
  type RunRecordInput,
} from "@kernel/schemas";

const AT = "2026-08-26T10:00:00.000Z";

/** Collect every issue message so assertions can target a specific diagnostic. */
const messagesOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((i) => i.message) ?? [];

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  description: `do ${id}`,
  dependsOn,
});

const planOf = (tasks: PlanInput["tasks"], revision = 0): PlanInput => ({
  goal: "ship the thing",
  tasks,
  createdAt: AT,
  revision,
});

/* -------------------------------------------------------------------------- */

describe("TaskStatus", () => {
  it("accepts the five lifecycle states", () => {
    for (const status of ["pending", "running", "completed", "failed", "blocked"]) {
      expect(TaskStatus.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an unknown state", () => {
    expect(TaskStatus.safeParse("cancelled").success).toBe(false);
  });

  it("treats completed, failed and blocked as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("blocked")).toBe(true);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
  });
});

describe("Task", () => {
  it("applies defaults so a planner need only supply id and description", () => {
    const parsed = Task.parse({ id: "t1", description: "fetch the story" });

    expect(parsed).toEqual({
      id: "t1",
      description: "fetch the story",
      dependsOn: [],
      status: "pending",
      attempts: 0,
    });
  });

  it("keeps an explicit agentHint", () => {
    const parsed = Task.parse({
      id: "t1",
      description: "fetch the story",
      agentHint: "research",
    });

    expect(parsed.agentHint).toBe("research");
  });

  it("rejects an empty id", () => {
    const result = Task.safeParse({ id: "", description: "x" });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("task id must not be empty");
  });

  it("rejects an empty description", () => {
    const result = Task.safeParse({ id: "t1", description: "" });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a task must describe what it does");
  });

  it("rejects a fractional or negative attempt count", () => {
    expect(Task.safeParse({ id: "t1", description: "x", attempts: 1.5 }).success).toBe(false);
    expect(Task.safeParse({ id: "t1", description: "x", attempts: -1 }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("findCycle", () => {
  it("returns null for a linear chain", () => {
    expect(findCycle([task("a"), task("b", ["a"]), task("c", ["b"])])).toBeNull();
  });

  it("returns null for a diamond (shared dependency is not a cycle)", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])];

    expect(findCycle(tasks)).toBeNull();
  });

  it("detects a two-node cycle and names both nodes", () => {
    const cycle = findCycle([task("a", ["b"]), task("b", ["a"])]);

    expect(cycle).not.toBeNull();
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
    // The path repeats its entry node so the loop reads as a loop.
    expect(cycle?.at(0)).toBe(cycle?.at(-1));
  });

  it("detects a self-dependency", () => {
    expect(findCycle([task("a", ["a"])])).toEqual(["a", "a"]);
  });

  it("detects a cycle buried behind valid tasks", () => {
    const tasks = [task("a"), task("b", ["a"]), task("c", ["d"]), task("d", ["c"])];

    expect(findCycle(tasks)).not.toBeNull();
  });

  it("ignores dangling dependencies rather than crashing on them", () => {
    expect(findCycle([task("a", ["ghost"])])).toBeNull();
  });

  it("returns null for an empty graph", () => {
    expect(findCycle([])).toBeNull();
  });
});

describe("findUnresolvedDependencies", () => {
  it("reports each dangling reference with its owner", () => {
    expect(findUnresolvedDependencies([task("a", ["ghost"])])).toEqual([
      { taskId: "a", missing: "ghost" },
    ]);
  });

  it("returns nothing when every reference resolves", () => {
    expect(findUnresolvedDependencies([task("a"), task("b", ["a"])])).toEqual([]);
  });
});

describe("findDuplicateIds", () => {
  it("reports an id used twice, once", () => {
    expect(findDuplicateIds([task("a"), task("a"), task("a")])).toEqual(["a"]);
  });

  it("returns nothing for unique ids", () => {
    expect(findDuplicateIds([task("a"), task("b")])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("Plan", () => {
  it("accepts a valid DAG with parallel branches", () => {
    const result = Plan.safeParse(
      planOf([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]),
    );

    expect(result.success).toBe(true);
  });

  // The acceptance test named in Phase 1.
  it("rejects a cyclic plan", () => {
    const result = Plan.safeParse(planOf([task("a", ["b"]), task("b", ["a"])]));

    expect(result.success).toBe(false);
    expect(messagesOf(result).some((m) => m.startsWith("dependency cycle:"))).toBe(true);
  });

  it("rejects a plan whose only task depends on itself", () => {
    const result = Plan.safeParse(planOf([task("a", ["a"])]));

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("dependency cycle: a -> a");
  });

  it("rejects a dependency on a task that does not exist", () => {
    const result = Plan.safeParse(planOf([task("a", ["ghost"])]));

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain('task "a" depends on unknown task "ghost"');
  });

  it("rejects duplicate task ids", () => {
    const result = Plan.safeParse(planOf([task("a"), task("a")]));

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain('duplicate task id: "a"');
  });

  it("reports every structural problem in one parse", () => {
    // The planner feeds these back to the model on retry, so one round-trip
    // must surface everything wrong rather than the first thing wrong.
    const result = Plan.safeParse(
      planOf([task("a", ["ghost"]), task("a", []), task("b", ["c"]), task("c", ["b"])]),
    );

    const messages = messagesOf(result);
    expect(result.success).toBe(false);
    expect(messages).toContain('duplicate task id: "a"');
    expect(messages).toContain('task "a" depends on unknown task "ghost"');
    expect(messages.some((m) => m.startsWith("dependency cycle:"))).toBe(true);
  });

  it("rejects an empty task list", () => {
    const result = Plan.safeParse(planOf([]));

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a plan must contain at least one task");
  });

  it("rejects a missing goal", () => {
    const result = Plan.safeParse({ ...planOf([task("a")]), goal: "" });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a plan must state the goal it serves");
  });

  it("rejects a non-ISO createdAt", () => {
    const result = Plan.safeParse({ ...planOf([task("a")]), createdAt: "yesterday" });

    expect(result.success).toBe(false);
  });

  it("rejects a negative revision", () => {
    expect(Plan.safeParse(planOf([task("a")], -1)).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("AgentResult", () => {
  it("defaults tool calls and token counts", () => {
    const parsed = AgentResult.parse({ taskId: "t1", ok: true, output: "done" });

    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.tokensIn).toBe(0);
    expect(parsed.tokensOut).toBe(0);
  });

  it("records tool calls with their arguments", () => {
    const parsed = AgentResult.parse({
      taskId: "t1",
      ok: true,
      toolCalls: [{ tool: "addTwoNumbers", args: { a: 1, b: 2 }, ok: true, durationMs: 4 }],
    });

    expect(parsed.toolCalls[0]?.tool).toBe("addTwoNumbers");
    expect(parsed.toolCalls[0]?.args).toEqual({ a: 1, b: 2 });
  });

  it("rejects a failure with no explanation", () => {
    const result = AgentResult.safeParse({ taskId: "t1", ok: false });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a failed result must explain why it failed");
  });

  it("rejects a failure whose explanation is empty", () => {
    const result = AgentResult.safeParse({ taskId: "t1", ok: false, error: "" });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a failed result must explain why it failed");
  });

  it("rejects a success that also carries an error", () => {
    const result = AgentResult.safeParse({ taskId: "t1", ok: true, error: "boom" });

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a successful result must not carry an error");
  });

  it("accepts a well-formed failure", () => {
    const result = AgentResult.safeParse({ taskId: "t1", ok: false, error: "rate limited" });

    expect(result.success).toBe(true);
  });

  it("rejects negative token counts", () => {
    expect(
      AgentResult.safeParse({ taskId: "t1", ok: true, tokensIn: -1 }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("Event", () => {
  const base = { runId: "run-1", at: AT };

  it("accepts each of the six event types", () => {
    const events = [
      { ...base, type: "plan_created", revision: 0, taskCount: 3 },
      { ...base, type: "task_started", taskId: "t1", agent: "research", attempt: 1 },
      {
        ...base,
        type: "task_completed",
        taskId: "t1",
        result: { taskId: "t1", ok: true, output: "ok" },
      },
      { ...base, type: "task_failed", taskId: "t1", error: "boom", attempt: 1, willRetry: true },
      { ...base, type: "replan", fromRevision: 0, toRevision: 1, reason: "tool unavailable" },
      { ...base, type: "run_completed", ok: true, finalOutput: "done" },
    ];

    for (const event of events) {
      expect(Event.safeParse(event), `failed on ${event.type}`).toMatchObject({ success: true });
    }
  });

  it("rejects an unknown event type", () => {
    expect(Event.safeParse({ ...base, type: "task_paused", taskId: "t1" }).success).toBe(false);
  });

  it("validates the nested AgentResult inside task_completed", () => {
    const result = Event.safeParse({
      ...base,
      type: "task_completed",
      taskId: "t1",
      result: { taskId: "t1", ok: false },
    });

    expect(result.success).toBe(false);
  });

  it("requires a reason on a replan", () => {
    const result = Event.safeParse({
      ...base,
      type: "replan",
      fromRevision: 0,
      toRevision: 1,
      reason: "",
    });

    expect(result.success).toBe(false);
  });

  it("requires a replan to move to revision 1 or later", () => {
    const result = Event.safeParse({
      ...base,
      type: "replan",
      fromRevision: 0,
      toRevision: 0,
      reason: "nope",
    });

    expect(result.success).toBe(false);
  });

  it("requires an attempt of at least 1 on task_started", () => {
    const result = Event.safeParse({
      ...base,
      type: "task_started",
      taskId: "t1",
      agent: "research",
      attempt: 0,
    });

    expect(result.success).toBe(false);
  });

  it("narrows to the right member on a discriminated switch", () => {
    const parsed = Event.parse({ ...base, type: "task_failed", taskId: "t1", error: "boom", attempt: 2, willRetry: false });

    if (parsed.type === "task_failed") {
      expect(parsed.willRetry).toBe(false);
      expect(parsed.attempt).toBe(2);
    } else {
      expect.unreachable("expected a task_failed event");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("TokenUsage", () => {
  it("defaults both directions to zero", () => {
    expect(TokenUsage.parse({})).toEqual({ in: 0, out: 0 });
  });
});

describe("RunRecord", () => {
  const runOf = (overrides: Partial<RunRecordInput> = {}): RunRecordInput => ({
    runId: "run-1",
    goal: "ship the thing",
    planRevisions: [planOf([task("a")])],
    events: [],
    startedAt: AT,
    ...overrides,
  });

  it("accepts a minimal record and defaults usage and cost", () => {
    const parsed = RunRecord.parse(runOf());

    expect(parsed.totalTokens).toEqual({ in: 0, out: 0 });
    expect(parsed.costUsd).toBe(0);
    expect(parsed.events).toEqual([]);
  });

  it("accepts an appended replan revision", () => {
    const result = RunRecord.safeParse(
      runOf({
        planRevisions: [planOf([task("a")], 0), planOf([task("a"), task("b", ["a"])], 1)],
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects plan revisions that are out of order", () => {
    const result = RunRecord.safeParse(
      runOf({ planRevisions: [planOf([task("a")], 0), planOf([task("a")], 5)] }),
    );

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain(
      "plan revisions must be contiguous from 0; expected 1, got 5",
    );
  });

  it("rejects a first revision that is not 0", () => {
    const result = RunRecord.safeParse({ ...runOf(), planRevisions: [planOf([task("a")], 1)] });

    expect(result.success).toBe(false);
  });

  it("rejects a revision that drifts from the run's goal", () => {
    const result = RunRecord.safeParse(
      runOf({
        planRevisions: [
          planOf([task("a")], 0),
          { ...planOf([task("a")], 1), goal: "something else" },
        ],
      }),
    );

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("every plan revision must serve the run's goal");
  });

  it("rejects an event that leaked in from another run", () => {
    const result = RunRecord.safeParse(
      runOf({
        events: [{ runId: "run-2", at: AT, type: "plan_created", revision: 0, taskCount: 1 }],
      }),
    );

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain('event belongs to run "run-2", not "run-1"');
  });

  it("rejects an empty plan history", () => {
    const result = RunRecord.safeParse(runOf({ planRevisions: [] }));

    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("a run must have at least one plan");
  });

  it("rejects a negative cost", () => {
    expect(RunRecord.safeParse(runOf({ costUsd: -0.01 })).success).toBe(false);
  });

  it("survives a JSON round trip (the record is the durable format)", () => {
    const parsed = RunRecord.parse(
      runOf({
        events: [{ runId: "run-1", at: AT, type: "run_completed", ok: true, finalOutput: "done" }],
        finalOutput: "done",
        completedAt: AT,
      }),
    );

    const reparsed = RunRecord.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reparsed).toEqual(parsed);
  });
});
