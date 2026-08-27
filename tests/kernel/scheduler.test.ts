import { describe, expect, it } from "vitest";

import { deriveState } from "@kernel/blackboard";
import {
  dependentsOf,
  downstreamOf,
  executionWaves,
  isStalled,
  readyTasks,
  sinkTasks,
} from "@kernel/scheduler";
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

const completed = (taskId: string): Event => ({
  type: "task_completed",
  runId: RUN,
  at: AT,
  taskId,
  result: { taskId, ok: true, toolCalls: [], tokensIn: 0, tokensOut: 0 },
});

const failed = (taskId: string): Event => ({
  type: "task_failed",
  runId: RUN,
  at: AT,
  taskId,
  error: "boom",
  attempt: 1,
  willRetry: false,
});

const running = (taskId: string): Event => ({
  type: "task_started",
  runId: RUN,
  at: AT,
  taskId,
  agent: "stub",
  attempt: 1,
});

/** The 5-task, 2-branch plan named in the Phase 3 acceptance criterion. */
const branching = planOf([
  { id: "root" },
  { id: "left", dependsOn: ["root"] },
  { id: "right", dependsOn: ["root"] },
  { id: "join", dependsOn: ["left", "right"] },
  { id: "report", dependsOn: ["join"] },
]);

const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id);

/* -------------------------------------------------------------------------- */

describe("readyTasks", () => {
  it("starts with only the dependency-free roots", () => {
    expect(ids(readyTasks(branching, deriveState(branching, [])))).toEqual(["root"]);
  });

  it("releases both branches at once when their shared dependency completes", () => {
    const state = deriveState(branching, [completed("root")]);

    // This is the parallelism the orchestrator exploits.
    expect(ids(readyTasks(branching, state))).toEqual(["left", "right"]);
  });

  it("holds a join until every dependency completes, not just one", () => {
    const state = deriveState(branching, [completed("root"), completed("left")]);

    expect(ids(readyTasks(branching, state))).toEqual(["right"]);
  });

  it("releases the join once both branches complete", () => {
    const state = deriveState(branching, [
      completed("root"),
      completed("left"),
      completed("right"),
    ]);

    expect(ids(readyTasks(branching, state))).toEqual(["join"]);
  });

  it("never returns a running task", () => {
    const state = deriveState(branching, [running("root")]);

    expect(readyTasks(branching, state)).toEqual([]);
  });

  it("never returns a blocked task", () => {
    const state = deriveState(branching, [completed("root"), failed("left")]);

    // "join" depends on the failure and must not be offered for dispatch.
    expect(ids(readyTasks(branching, state))).toEqual(["right"]);
  });

  it("returns nothing when the run is finished", () => {
    const state = deriveState(branching, [
      completed("root"),
      completed("left"),
      completed("right"),
      completed("join"),
      completed("report"),
    ]);

    expect(readyTasks(branching, state)).toEqual([]);
  });
});

describe("dependentsOf", () => {
  it("finds direct dependents only", () => {
    expect(ids(dependentsOf(branching, "root"))).toEqual(["left", "right"]);
    expect(ids(dependentsOf(branching, "join"))).toEqual(["report"]);
  });

  it("returns nothing for a sink", () => {
    expect(dependentsOf(branching, "report")).toEqual([]);
  });
});

describe("downstreamOf", () => {
  it("returns the full transitive blast radius in plan order", () => {
    expect(ids(downstreamOf(branching, "root"))).toEqual([
      "left",
      "right",
      "join",
      "report",
    ]);
  });

  it("returns only the affected subtree for a branch", () => {
    expect(ids(downstreamOf(branching, "left"))).toEqual(["join", "report"]);
  });

  it("returns nothing for a sink", () => {
    expect(downstreamOf(branching, "report")).toEqual([]);
  });

  it("does not revisit a task reachable by two paths", () => {
    // "join" is downstream of both branches; it must appear exactly once.
    const result = ids(downstreamOf(branching, "root"));

    expect(new Set(result).size).toBe(result.length);
  });
});

describe("isStalled", () => {
  it("is false at the start of a run", () => {
    expect(isStalled(branching, deriveState(branching, []))).toBe(false);
  });

  it("is false while a task is running", () => {
    expect(isStalled(branching, deriveState(branching, [running("root")]))).toBe(false);
  });

  it("is false when the run has finished", () => {
    const state = deriveState(branching, [failed("root")]);

    // Everything downstream is blocked, which is terminal, not stalled.
    expect(isStalled(branching, state)).toBe(false);
  });

  it("detects corrupted state where a task can never become ready", () => {
    // Unreachable through deriveState with a validated plan, which is exactly
    // why the guard is worth asserting: if it ever does happen, the
    // orchestrator must throw rather than spin forever. Here the dependency is
    // simply absent from the state map.
    const chain = planOf([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
    const corrupted = {
      tasks: new Map([["b", { id: "b", status: "pending" as const, attempts: 0 }]]),
      tokensIn: 0,
      tokensOut: 0,
    };

    expect(isStalled(chain, corrupted)).toBe(true);
  });
});

describe("sinkTasks", () => {
  it("returns the tasks nothing depends on", () => {
    expect(ids(sinkTasks(branching))).toEqual(["report"]);
  });

  it("returns several sinks when a plan has them", () => {
    const forked = planOf([{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["a"] }]);

    expect(ids(sinkTasks(forked))).toEqual(["b", "c"]);
  });
});

describe("executionWaves", () => {
  it("groups the branching plan into four waves", () => {
    expect(executionWaves(branching).map(ids)).toEqual([
      ["root"],
      ["left", "right"],
      ["join"],
      ["report"],
    ]);
  });

  it("puts wholly independent tasks in a single wave", () => {
    const flat = planOf([{ id: "a" }, { id: "b" }, { id: "c" }]);

    expect(executionWaves(flat).map(ids)).toEqual([["a", "b", "c"]]);
  });

  it("puts a chain in one wave per task", () => {
    const chain = planOf([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ]);

    expect(executionWaves(chain)).toHaveLength(3);
  });
});
