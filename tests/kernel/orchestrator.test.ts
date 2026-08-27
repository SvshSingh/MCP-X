import { describe, expect, it, vi } from "vitest";

import { taskState } from "@kernel/blackboard";
import {
  blockedByFailures,
  defaultClassifier,
  runPlan,
  type AgentRunner,
} from "@kernel/orchestrator";
import { Plan, RunRecord, type Task } from "@kernel/schemas";

const AT = "2026-08-27T10:00:00.000Z";
const now = () => new Date(AT);

const planOf = (tasks: { id: string; dependsOn?: string[]; agentHint?: string }[]) =>
  Plan.parse({
    goal: "ship the thing",
    tasks: tasks.map((t) => ({
      id: t.id,
      description: `do ${t.id}`,
      dependsOn: t.dependsOn ?? [],
      ...(t.agentHint === undefined ? {} : { agentHint: t.agentHint }),
    })),
    createdAt: AT,
    revision: 0,
  });

/** The 5-task, 2-parallel-branch plan from the Phase 3 acceptance criterion. */
const branching = planOf([
  { id: "root" },
  { id: "left", dependsOn: ["root"] },
  { id: "right", dependsOn: ["root"] },
  { id: "join", dependsOn: ["left", "right"] },
  { id: "report", dependsOn: ["join"] },
]);

/** Succeeds at everything, recording the order tasks were entered. */
const recordingRunner = (order: string[]): AgentRunner => {
  return (task: Task) => {
    order.push(task.id);
    return { taskId: task.id, ok: true, output: `${task.id} ok`, tokensIn: 3, tokensOut: 2 };
  };
};

const failOn = (failing: Set<string>, order: string[] = []): AgentRunner => {
  return (task: Task) => {
    order.push(task.id);
    return failing.has(task.id)
      ? { taskId: task.id, ok: false, error: `${task.id} exploded` }
      : { taskId: task.id, ok: true, output: `${task.id} ok` };
  };
};

const statusOf = (outcome: Awaited<ReturnType<typeof runPlan>>, id: string) =>
  taskState(outcome.state, id).status;

/* -------------------------------------------------------------------------- */

describe("runPlan — happy path", () => {
  // First half of the Phase 3 acceptance criterion.
  it("executes a 5-task, 2-branch plan in dependency order", async () => {
    const order: string[] = [];

    const outcome = await runPlan({
      plan: branching,
      execute: recordingRunner(order),
      now,
      runId: "run-1",
    });

    expect(outcome.ok).toBe(true);
    expect(order).toHaveLength(5);

    // Order within a wave is unspecified; order between waves is not.
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("left"));
    expect(order.indexOf("root")).toBeLessThan(order.indexOf("right"));
    expect(order.indexOf("left")).toBeLessThan(order.indexOf("join"));
    expect(order.indexOf("right")).toBeLessThan(order.indexOf("join"));
    expect(order.indexOf("join")).toBeLessThan(order.indexOf("report"));
  });

  it("marks every task completed", async () => {
    const outcome = await runPlan({ plan: branching, execute: recordingRunner([]), now });

    for (const id of ["root", "left", "right", "join", "report"]) {
      expect(statusOf(outcome, id), id).toBe("completed");
    }
  });

  it("dispatches the two branches concurrently, not one after the other", async () => {
    let inFlight = 0;
    let peak = 0;

    const outcome = await runPlan({
      plan: branching,
      now,
      execute: async (task) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { taskId: task.id, ok: true, output: "ok" };
      },
    });

    // Sequential execution would never exceed 1.
    expect(peak).toBe(2);
    expect(outcome.ok).toBe(true);
  });

  it("sums tokens across every task", async () => {
    const outcome = await runPlan({ plan: branching, execute: recordingRunner([]), now });

    expect(outcome.record.totalTokens).toEqual({ in: 15, out: 10 });
  });

  it("emits a well-formed, schema-valid RunRecord", async () => {
    const outcome = await runPlan({
      plan: branching,
      execute: recordingRunner([]),
      now,
      runId: "run-1",
    });

    expect(() => RunRecord.parse(outcome.record)).not.toThrow();
    expect(outcome.record.runId).toBe("run-1");
    expect(outcome.record.goal).toBe("ship the thing");
    expect(outcome.record.planRevisions).toHaveLength(1);
  });

  it("opens with plan_created and closes with run_completed", async () => {
    const outcome = await runPlan({ plan: branching, execute: recordingRunner([]), now });
    const types = outcome.record.events.map((e) => e.type);

    expect(types[0]).toBe("plan_created");
    expect(types.at(-1)).toBe("run_completed");
  });

  it("logs a start and a completion for every task", async () => {
    const outcome = await runPlan({ plan: branching, execute: recordingRunner([]), now });
    const types = outcome.record.events.map((e) => e.type);

    expect(types.filter((t) => t === "task_started")).toHaveLength(5);
    expect(types.filter((t) => t === "task_completed")).toHaveLength(5);
  });

  it("takes the final output from the plan's sink", async () => {
    const outcome = await runPlan({ plan: branching, execute: recordingRunner([]), now });

    expect(outcome.record.finalOutput).toBe("report ok");
  });

  it("routes each task to the agent its hint names", async () => {
    const hinted = planOf([
      { id: "a", agentHint: "research" },
      { id: "b", dependsOn: ["a"], agentHint: "publish" },
    ]);

    const outcome = await runPlan({ plan: hinted, execute: recordingRunner([]), now });

    expect(taskState(outcome.state, "a").agent).toBe("research");
    expect(taskState(outcome.state, "b").agent).toBe("publish");
  });

  it("accepts a custom classifier", async () => {
    const outcome = await runPlan({
      plan: planOf([{ id: "a" }]),
      execute: recordingRunner([]),
      classify: () => "specialist-7",
      now,
    });

    expect(taskState(outcome.state, "a").agent).toBe("specialist-7");
  });
});

/* -------------------------------------------------------------------------- */

describe("runPlan — failure policy", () => {
  // Second half of the Phase 3 acceptance criterion.
  it("blocks only the dependent subtree when a task fails mid-plan", async () => {
    const outcome = await runPlan({
      plan: branching,
      execute: failOn(new Set(["left"])),
      maxAttemptsPerTask: 1,
      now,
    });

    expect(outcome.ok).toBe(false);
    expect(statusOf(outcome, "left")).toBe("failed");

    // The sibling branch is untouched and still runs to completion.
    expect(statusOf(outcome, "root")).toBe("completed");
    expect(statusOf(outcome, "right")).toBe("completed");

    // Only what actually depended on the failure is blocked.
    expect(statusOf(outcome, "join")).toBe("blocked");
    expect(statusOf(outcome, "report")).toBe("blocked");
  });

  it("still runs the sibling branch rather than abandoning the wave", async () => {
    const order: string[] = [];

    await runPlan({
      plan: branching,
      execute: failOn(new Set(["left"]), order),
      maxAttemptsPerTask: 1,
      now,
    });

    // allSettled, not all: "right" must not be cancelled by "left" failing.
    expect(order).toContain("right");
  });

  it("retries a failing task up to the cap", async () => {
    const attempts: number[] = [];

    const outcome = await runPlan({
      plan: planOf([{ id: "a" }]),
      maxAttemptsPerTask: 3,
      now,
      execute: (task, ctx) => {
        attempts.push(ctx.attempt);
        return { taskId: task.id, ok: false, error: "nope" };
      },
    });

    expect(attempts).toEqual([1, 2, 3]);
    expect(statusOf(outcome, "a")).toBe("failed");
  });

  it("stops retrying as soon as an attempt succeeds", async () => {
    const calls: number[] = [];

    const outcome = await runPlan({
      plan: planOf([{ id: "a" }]),
      maxAttemptsPerTask: 5,
      now,
      execute: (task, ctx) => {
        calls.push(ctx.attempt);
        return ctx.attempt >= 2
          ? { taskId: task.id, ok: true, output: "recovered" }
          : { taskId: task.id, ok: false, error: "transient" };
      },
    });

    expect(calls).toEqual([1, 2]);
    expect(statusOf(outcome, "a")).toBe("completed");
    expect(outcome.ok).toBe(true);
  });

  it("marks intermediate failures willRetry and the last one not", async () => {
    const outcome = await runPlan({
      plan: planOf([{ id: "a" }]),
      maxAttemptsPerTask: 2,
      now,
      execute: (task) => ({ taskId: task.id, ok: false, error: "nope" }),
    });

    const failures = outcome.record.events.filter((e) => e.type === "task_failed");

    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({ attempt: 1, willRetry: true });
    expect(failures[1]).toMatchObject({ attempt: 2, willRetry: false });
  });

  it("treats a thrown error as a failed result rather than crashing the run", async () => {
    const outcome = await runPlan({
      plan: branching,
      maxAttemptsPerTask: 1,
      now,
      execute: (task) => {
        if (task.id === "left") throw new Error("agent blew up");
        return { taskId: task.id, ok: true, output: "ok" };
      },
    });

    expect(statusOf(outcome, "left")).toBe("failed");
    expect(taskState(outcome.state, "left").error).toContain("agent blew up");
    expect(statusOf(outcome, "right")).toBe("completed");
  });

  it("gives a non-descriptive throw a usable error message", async () => {
    const outcome = await runPlan({
      plan: planOf([{ id: "a" }]),
      maxAttemptsPerTask: 1,
      now,
      // AgentResult refuses a failure with no reason; an empty throw must not
      // be able to violate that invariant.
      execute: () => {
        throw new Error("");
      },
    });

    expect(taskState(outcome.state, "a").error).toBeTruthy();
  });

  it("reports ok=false and a truthful run_completed event", async () => {
    const outcome = await runPlan({
      plan: branching,
      execute: failOn(new Set(["root"])),
      maxAttemptsPerTask: 1,
      now,
    });

    const final = outcome.record.events.at(-1);
    expect(final).toMatchObject({ type: "run_completed", ok: false });
  });

  it("blocks the entire plan when the root fails", async () => {
    const outcome = await runPlan({
      plan: branching,
      execute: failOn(new Set(["root"])),
      maxAttemptsPerTask: 1,
      now,
    });

    for (const id of ["left", "right", "join", "report"]) {
      expect(statusOf(outcome, id), id).toBe("blocked");
    }
  });

  it("never dispatches a blocked task", async () => {
    const order: string[] = [];

    await runPlan({
      plan: branching,
      execute: failOn(new Set(["root"]), order),
      maxAttemptsPerTask: 1,
      now,
    });

    expect(order).toEqual(["root"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("blockedByFailures", () => {
  it("maps each terminal failure to its blast radius", async () => {
    const outcome = await runPlan({
      plan: branching,
      execute: failOn(new Set(["left"])),
      maxAttemptsPerTask: 1,
      now,
    });

    expect(blockedByFailures(branching, outcome.state)).toEqual(
      new Map([["left", ["join", "report"]]]),
    );
  });

  it("is empty for a successful run", async () => {
    const outcome = await runPlan({ plan: branching, execute: recordingRunner([]), now });

    expect(blockedByFailures(branching, outcome.state).size).toBe(0);
  });
});

describe("defaultClassifier", () => {
  it("uses the planner's hint when present", () => {
    expect(defaultClassifier({ id: "a", agentHint: "research" } as Task)).toBe("research");
  });

  it("falls back to a default agent", () => {
    expect(defaultClassifier({ id: "a" } as Task)).toBe("default");
  });
});

describe("runPlan — observability", () => {
  it("notifies onEvent for every appended event", async () => {
    const seen = vi.fn();

    const outcome = await runPlan({
      plan: planOf([{ id: "a" }]),
      execute: recordingRunner([]),
      onEvent: seen,
      now,
    });

    expect(seen).toHaveBeenCalledTimes(outcome.record.events.length);
  });

  it("generates a runId when none is supplied", async () => {
    const outcome = await runPlan({ plan: planOf([{ id: "a" }]), execute: recordingRunner([]), now });

    expect(outcome.record.runId).toMatch(/^run-/);
  });
});
