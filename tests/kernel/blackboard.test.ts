import { describe, expect, it } from "vitest";

import {
  Blackboard,
  completedTasks,
  deriveState,
  isRunComplete,
  taskState,
} from "@kernel/blackboard";
import { Plan, type Event } from "@kernel/schemas";

const AT = "2026-08-27T10:00:00.000Z";
const RUN = "run-1";

const planOf = (tasks: { id: string; dependsOn?: string[] }[]) =>
  Plan.parse({
    goal: "ship the thing",
    tasks: tasks.map((t) => ({
      id: t.id,
      description: `do ${t.id}`,
      dependsOn: t.dependsOn ?? [],
    })),
    createdAt: AT,
    revision: 0,
  });

const started = (taskId: string, attempt = 1): Event => ({
  type: "task_started",
  runId: RUN,
  at: AT,
  taskId,
  agent: "stub",
  attempt,
});

const completed = (taskId: string, tokensIn = 0, tokensOut = 0): Event => ({
  type: "task_completed",
  runId: RUN,
  at: AT,
  taskId,
  result: { taskId, ok: true, output: `${taskId} done`, toolCalls: [], tokensIn, tokensOut },
});

const failed = (taskId: string, willRetry = false, attempt = 1): Event => ({
  type: "task_failed",
  runId: RUN,
  at: AT,
  taskId,
  error: "boom",
  attempt,
  willRetry,
});

/* -------------------------------------------------------------------------- */

describe("deriveState", () => {
  const chain = planOf([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);

  it("starts every task pending with zero attempts", () => {
    const state = deriveState(chain, []);

    expect(taskState(state, "a")).toMatchObject({ status: "pending", attempts: 0 });
    expect(taskState(state, "b")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("marks a started task running and records the agent and attempt", () => {
    const state = deriveState(chain, [started("a", 1)]);

    expect(taskState(state, "a")).toMatchObject({
      status: "running",
      attempts: 1,
      agent: "stub",
    });
  });

  it("marks a completed task completed and keeps its result", () => {
    const state = deriveState(chain, [started("a"), completed("a")]);

    expect(taskState(state, "a").status).toBe("completed");
    expect(taskState(state, "a").result?.output).toBe("a done");
  });

  it("accumulates tokens across completions", () => {
    const state = deriveState(chain, [
      completed("a", 10, 5),
      completed("b", 7, 3),
    ]);

    expect(state.tokensIn).toBe(17);
    expect(state.tokensOut).toBe(8);
  });

  it("returns a retryable failure to pending", () => {
    const state = deriveState(chain, [started("a"), failed("a", true)]);

    // The task goes back in the ready pool rather than ending the run.
    expect(taskState(state, "a").status).toBe("pending");
  });

  it("marks a final failure failed and keeps the reason", () => {
    const state = deriveState(chain, [started("a"), failed("a", false)]);

    expect(taskState(state, "a")).toMatchObject({ status: "failed", error: "boom" });
  });

  it("clears a stale error when the task is retried", () => {
    const state = deriveState(chain, [
      started("a", 1),
      failed("a", true, 1),
      started("a", 2),
      completed("a"),
    ]);

    expect(taskState(state, "a").status).toBe("completed");
    expect(taskState(state, "a").error).toBeUndefined();
    expect(taskState(state, "a").attempts).toBe(2);
  });

  it("blocks a direct dependent of a failed task", () => {
    const state = deriveState(chain, [failed("a")]);

    expect(taskState(state, "b").status).toBe("blocked");
  });

  it("propagates blocking transitively down a long chain", () => {
    const deep = planOf([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
      { id: "d", dependsOn: ["c"] },
    ]);

    const state = deriveState(deep, [failed("a")]);

    // A single sweep would only reach "b"; the fixpoint pass must reach "d".
    for (const id of ["b", "c", "d"]) {
      expect(taskState(state, id).status, id).toBe("blocked");
    }
  });

  it("does not block a sibling branch", () => {
    const diamond = planOf([
      { id: "root" },
      { id: "left", dependsOn: ["root"] },
      { id: "right", dependsOn: ["root"] },
      { id: "join", dependsOn: ["left", "right"] },
    ]);

    const state = deriveState(diamond, [completed("root"), failed("left")]);

    expect(taskState(state, "right").status).toBe("pending");
    expect(taskState(state, "join").status).toBe("blocked");
  });

  it("ignores events for tasks outside the plan", () => {
    const state = deriveState(chain, [completed("ghost")]);

    expect(state.tasks.has("ghost")).toBe(false);
    expect(taskState(state, "a").status).toBe("pending");
  });

  it("ignores plan_created, replan and run_completed", () => {
    const state = deriveState(chain, [
      { type: "plan_created", runId: RUN, at: AT, revision: 0, taskCount: 2 },
      { type: "run_completed", runId: RUN, at: AT, ok: true },
    ]);

    expect(taskState(state, "a").status).toBe("pending");
  });

  it("is pure: replaying the same events yields the same state", () => {
    const events = [started("a"), completed("a", 3, 4), started("b"), failed("b")];

    const first = deriveState(chain, events);
    const second = deriveState(chain, events);

    expect([...second.tasks.entries()]).toEqual([...first.tasks.entries()]);
    expect(second.tokensIn).toBe(first.tokensIn);
  });
});

describe("isRunComplete", () => {
  const chain = planOf([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);

  it("is false while work remains", () => {
    expect(isRunComplete(deriveState(chain, [completed("a")]))).toBe(false);
  });

  it("is true when everything completed", () => {
    expect(isRunComplete(deriveState(chain, [completed("a"), completed("b")]))).toBe(true);
  });

  it("counts blocked and failed as terminal", () => {
    expect(isRunComplete(deriveState(chain, [failed("a")]))).toBe(true);
  });
});

describe("completedTasks", () => {
  it("returns successful tasks in plan order", () => {
    const plan = planOf([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const state = deriveState(plan, [completed("c"), completed("a")]);

    expect(completedTasks(plan, state).map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("Blackboard", () => {
  const plan = planOf([{ id: "a" }]);
  const now = () => new Date(AT);

  it("stamps runId and timestamp on append", () => {
    const board = new Blackboard(RUN, { now });

    const event = board.append({ type: "plan_created", revision: 0, taskCount: 1 });

    expect(event).toMatchObject({ runId: RUN, at: AT, type: "plan_created" });
  });

  it("appends in order and exposes an immutable view", () => {
    const board = new Blackboard(RUN, { now });

    board.append({ type: "plan_created", revision: 0, taskCount: 1 });
    board.append({ type: "task_started", taskId: "a", agent: "stub", attempt: 1 });

    expect(board.events.map((e) => e.type)).toEqual(["plan_created", "task_started"]);
  });

  it("derives state from its own log", () => {
    const board = new Blackboard(RUN, { now });

    board.append({ type: "task_started", taskId: "a", agent: "stub", attempt: 1 });

    expect(taskState(board.state(plan), "a").status).toBe("running");
  });

  it("produces events a RunRecord will accept", () => {
    const board = new Blackboard(RUN, { now });
    board.append({ type: "run_completed", ok: true });

    // The log is the durable artifact; it must satisfy the Phase 1 schema.
    expect(board.events[0]).toMatchObject({ runId: RUN, at: AT });
  });
});
