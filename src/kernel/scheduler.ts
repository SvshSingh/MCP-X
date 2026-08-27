/**
 * Dependency-aware scheduling.
 *
 * Every function here is pure: plan plus state in, decision out. Readiness and
 * blocking are the rules most likely to be subtly wrong, so they are testable
 * without running a single task.
 *
 * Phase 3 of ORCHESTRATOR_PLAN.md.
 */

import type { RunState } from "./blackboard.js";
import { isTerminal, type Plan, type Task } from "./schemas.js";

/**
 * Tasks that can start right now: pending, with every dependency completed.
 *
 * A dependency that failed or is blocked does not make a task ready — it makes
 * it blocked, which `deriveState` has already worked out. This function does
 * not need to re-derive that.
 */
export function readyTasks(plan: Plan, state: RunState): Task[] {
  return plan.tasks.filter((task) => {
    if (state.tasks.get(task.id)?.status !== "pending") return false;

    return task.dependsOn.every((dep) => state.tasks.get(dep)?.status === "completed");
  });
}

/** Direct dependents of a task. */
export const dependentsOf = (plan: Plan, taskId: string): Task[] =>
  plan.tasks.filter((task) => task.dependsOn.includes(taskId));

/**
 * Every task downstream of `taskId`, transitively.
 *
 * This is the blast radius of a failure: the set that can never run because
 * something they need did not produce a result.
 */
export function downstreamOf(plan: Plan, taskId: string): Task[] {
  const found = new Map<string, Task>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    for (const dependent of dependentsOf(plan, current)) {
      if (found.has(dependent.id)) continue;
      found.set(dependent.id, dependent);
      queue.push(dependent.id);
    }
  }

  // Plan order, so callers report a stable sequence.
  return plan.tasks.filter((task) => found.has(task.id));
}

/**
 * True when no task can start and none is in flight, yet work remains.
 *
 * With a validated DAG and correct blocking this should be unreachable. It is
 * checked anyway because the alternative failure mode is an orchestrator that
 * spins forever, which is far worse to diagnose than an explicit error.
 */
export function isStalled(plan: Plan, state: RunState): boolean {
  const anyRunning = [...state.tasks.values()].some((task) => task.status === "running");
  if (anyRunning) return false;

  const anyUnfinished = [...state.tasks.values()].some((task) => !isTerminal(task.status));
  if (!anyUnfinished) return false;

  return readyTasks(plan, state).length === 0;
}

/**
 * Tasks nothing depends on — the plan's outputs.
 *
 * Used to assemble a final answer until Phase 6 introduces a real synthesizer.
 */
export const sinkTasks = (plan: Plan): Task[] =>
  plan.tasks.filter((task) => dependentsOf(plan, task.id).length === 0);

/**
 * Groups tasks into the waves they would execute in, ignoring failure.
 *
 * Not used by the orchestrator, which recomputes readiness after every wave.
 * It exists so tests and the CLI can show a plan's theoretical parallelism,
 * and so Phase 7 can compute step efficiency against an optimal wave count.
 */
export function executionWaves(plan: Plan): Task[][] {
  const remaining = new Map(plan.tasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const waves: Task[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining.values()].filter((task) =>
      task.dependsOn.every((dep) => done.has(dep)),
    );

    // A validated Plan is acyclic, so a wave can never come back empty.
    if (wave.length === 0) break;

    for (const task of wave) {
      remaining.delete(task.id);
    }
    for (const task of wave) {
      done.add(task.id);
    }

    waves.push(wave);
  }

  return waves;
}
