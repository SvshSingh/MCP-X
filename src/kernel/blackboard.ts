/**
 * Append-only event log, and the state derived from it.
 *
 * The central rule: the log is the only writable thing. Task status, attempt
 * counts and token totals are never stored — they are recomputed from the
 * events by {@link deriveState}. Nothing can therefore drift out of sync with
 * the record, and Phase 5's replay is not a second implementation of the
 * orchestrator, it is this same function applied to events read off disk.
 *
 * Phase 3 of ORCHESTRATOR_PLAN.md.
 */

import {
  isTerminal,
  type AgentResult,
  type Event,
  type Plan,
  type Task,
  type TaskStatus,
} from "./schemas.js";

export interface TaskState {
  id: string;
  status: TaskStatus;
  /** Number of times execution has been started, not the number of failures. */
  attempts: number;
  /** The specialist the classifier chose on the most recent attempt. */
  agent?: string;
  /** Reason the task failed, when it did. */
  error?: string;
  result?: AgentResult;
}

export interface RunState {
  tasks: Map<string, TaskState>;
  tokensIn: number;
  tokensOut: number;
}

export const taskState = (state: RunState, id: string): TaskState => {
  const found = state.tasks.get(id);
  if (!found) throw new Error(`Unknown task "${id}"`);
  return found;
};

/**
 * Replays the log over a plan to produce current state.
 *
 * Pure and total: the same plan and events always yield the same state, which
 * is what lets a completed run be reconstructed from disk with no live calls.
 *
 * `blocked` is computed rather than recorded. A task is blocked when any
 * dependency failed terminally, or when a dependency is itself blocked. That
 * propagation is a fixpoint pass rather than a single sweep, so a failure
 * three levels up still blocks the whole subtree beneath it.
 */
export function deriveState(plan: Plan, events: readonly Event[]): RunState {
  const tasks = new Map<string, TaskState>(
    plan.tasks.map((task) => [task.id, { id: task.id, status: "pending", attempts: 0 }]),
  );

  let tokensIn = 0;
  let tokensOut = 0;

  for (const event of events) {
    switch (event.type) {
      case "task_started": {
        const state = tasks.get(event.taskId);
        if (!state) break;
        state.status = "running";
        state.attempts = event.attempt;
        state.agent = event.agent;
        delete state.error;
        break;
      }

      case "task_completed": {
        const state = tasks.get(event.taskId);
        if (!state) break;
        state.status = "completed";
        state.result = event.result;
        delete state.error;
        tokensIn += event.result.tokensIn;
        tokensOut += event.result.tokensOut;
        break;
      }

      case "task_failed": {
        const state = tasks.get(event.taskId);
        if (!state) break;
        // A retryable failure returns the task to the ready pool; only a final
        // failure is terminal.
        state.status = event.willRetry ? "pending" : "failed";
        state.error = event.error;
        break;
      }

      case "plan_created":
      case "replan":
      case "run_completed":
        break;
    }
  }

  // Fixpoint: keep propagating until nothing changes, so a failure blocks its
  // entire downstream subtree and not merely its immediate dependents.
  let changed = true;
  while (changed) {
    changed = false;

    for (const task of plan.tasks) {
      const state = tasks.get(task.id);
      if (!state || state.status !== "pending") continue;

      const upstreamDead = task.dependsOn.some((dep) => {
        const depState = tasks.get(dep);
        return depState?.status === "failed" || depState?.status === "blocked";
      });

      if (upstreamDead) {
        state.status = "blocked";
        changed = true;
      }
    }
  }

  return { tasks, tokensIn, tokensOut };
}

/** True when every task has reached a terminal status. */
export const isRunComplete = (state: RunState): boolean =>
  [...state.tasks.values()].every((task) => isTerminal(task.status));

/** Tasks that finished successfully, in plan order. */
export const completedTasks = (plan: Plan, state: RunState): Task[] =>
  plan.tasks.filter((task) => state.tasks.get(task.id)?.status === "completed");

/**
 * The event log for one run.
 *
 * `append` stamps `runId` and `at`, so callers cannot record an event against
 * the wrong run or with a clock the test does not control.
 */
export type EventInput =
  | Omit<Extract<Event, { type: "plan_created" }>, "runId" | "at">
  | Omit<Extract<Event, { type: "task_started" }>, "runId" | "at">
  | Omit<Extract<Event, { type: "task_completed" }>, "runId" | "at">
  | Omit<Extract<Event, { type: "task_failed" }>, "runId" | "at">
  | Omit<Extract<Event, { type: "replan" }>, "runId" | "at">
  | Omit<Extract<Event, { type: "run_completed" }>, "runId" | "at">;

export class Blackboard {
  readonly runId: string;

  readonly #events: Event[] = [];
  readonly #now: () => Date;

  constructor(runId: string, options: { now?: () => Date } = {}) {
    this.runId = runId;
    this.#now = options.now ?? (() => new Date());
  }

  /** Immutable view. The log is append-only; there is no update or delete. */
  get events(): readonly Event[] {
    return this.#events;
  }

  append(event: EventInput): Event {
    const stamped = {
      ...event,
      runId: this.runId,
      at: this.#now().toISOString(),
    } as Event;

    this.#events.push(stamped);
    return stamped;
  }

  state(plan: Plan): RunState {
    return deriveState(plan, this.#events);
  }
}
