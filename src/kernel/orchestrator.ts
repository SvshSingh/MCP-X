/**
 * The execution loop.
 *
 * Repeatedly: derive state from the log, ask the scheduler what is ready,
 * dispatch that whole wave concurrently, record what happened. Stop when every
 * task is terminal.
 *
 * State is never held in a variable across iterations — it is re-derived from
 * the event log each pass. That costs a cheap replay per wave and buys the
 * guarantee that what the orchestrator believes and what the record says can
 * never disagree.
 *
 * Phase 3 of ORCHESTRATOR_PLAN.md.
 */

import { Blackboard, taskState, type RunState } from "./blackboard.js";
import { downstreamOf, isStalled, readyTasks, sinkTasks } from "./scheduler.js";
import {
  AgentResult,
  RunRecord,
  type AgentResultInput,
  type Plan,
  type Task,
  type TokenUsage,
} from "./schemas.js";

export const DEFAULT_MAX_TASK_ATTEMPTS = 2;

/**
 * Executes one task. Phase 4 replaces the stub with real specialist agents.
 *
 * Returns the *input* shape, not the parsed one: the orchestrator parses every
 * result anyway, so an agent should not have to spell out `toolCalls: []` and
 * zeroed token counts just to report success.
 */
export type AgentRunner = (
  task: Task,
  context: { attempt: number; agent: string; state: RunState },
) => Promise<AgentResultInput> | AgentResultInput;

/**
 * Chooses the specialist for a task.
 *
 * Allowed to be async: keyword routing is synchronous, but an LLM classifier
 * is not, and Phase 6's replanning can introduce tasks mid-run that have never
 * been routed. Pre-classifying the whole plan up front would not cover that.
 */
export type Classifier = (task: Task) => string | Promise<string>;

export const defaultClassifier: Classifier = (task) => task.agentHint ?? "default";

export interface OrchestratorOptions {
  plan: Plan;
  execute: AgentRunner;
  classify?: Classifier;
  runId?: string;
  /** Attempts per task, including the first. */
  maxAttemptsPerTask?: number;
  now?: () => Date;
  /** Called for every appended event; useful for progress output and logging. */
  onEvent?: (event: Readonly<{ type: string }>) => void;
  /**
   * Tokens already spent before execution began — planning, replanning,
   * routing. Added to the run totals.
   *
   * Without this the record would sum only what tasks consumed, quietly
   * omitting the planner's spend. That is real money, and a cost report that
   * under-reports is worse than none because it gets trusted.
   */
  priorUsage?: TokenUsage;
}

export interface RunOutcome {
  record: RunRecord;
  state: RunState;
  ok: boolean;
}

/** Normalises anything an agent throws into a failed AgentResult. */
function resultFromThrow(task: Task, error: unknown): AgentResult {
  const message = error instanceof Error ? error.message : String(error);

  return AgentResult.parse({
    taskId: task.id,
    ok: false,
    // AgentResult refuses a failure with no reason, so never let one through.
    error: message === "" ? "Agent threw a non-descriptive error" : message,
  });
}

export async function runPlan(options: OrchestratorOptions): Promise<RunOutcome> {
  const { plan, execute } = options;
  const classify = options.classify ?? defaultClassifier;
  const maxAttempts = options.maxAttemptsPerTask ?? DEFAULT_MAX_TASK_ATTEMPTS;
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? `run-${now().getTime().toString(36)}`;

  const board = new Blackboard(runId, { now });
  const startedAt = now().toISOString();

  const emit = (event: Parameters<Blackboard["append"]>[0]): void => {
    const appended = board.append(event);
    options.onEvent?.(appended);
  };

  emit({ type: "plan_created", revision: plan.revision, taskCount: plan.tasks.length });

  for (;;) {
    const state = board.state(plan);

    const unfinished = [...state.tasks.values()].filter(
      (task) => task.status === "pending" || task.status === "running",
    );
    if (unfinished.length === 0) break;

    const wave = readyTasks(plan, state);

    if (wave.length === 0) {
      // Unreachable for a validated DAG with correct blocking. Fail loudly
      // rather than spin: a hung orchestrator is far worse to diagnose.
      if (isStalled(plan, state)) {
        throw new Error(
          `Run ${runId} stalled: ${unfinished.length} task(s) can never become ready (${unfinished
            .map((t) => t.id)
            .join(", ")})`,
        );
      }
      break;
    }

    // Route the wave first. Classification may be async and may itself call a
    // model, so it happens concurrently rather than task by task.
    const routed = await Promise.all(
      wave.map(async (task) => ({
        task,
        attempt: taskState(state, task.id).attempts + 1,
        agent: await classify(task),
      })),
    );

    // Mark the whole wave started before any of it runs, so the log shows what
    // was dispatched together rather than implying a sequence.
    const dispatched = routed.map((entry) => {
      emit({
        type: "task_started",
        taskId: entry.task.id,
        agent: entry.agent,
        attempt: entry.attempt,
      });
      return entry;
    });

    // allSettled, not all: one task failing must not abandon its siblings,
    // which may be the only work that can still make progress.
    const settled = await Promise.allSettled(
      dispatched.map(async ({ task, attempt, agent }) =>
        execute(task, { attempt, agent, state }),
      ),
    );

    settled.forEach((outcome, index) => {
      const entry = dispatched[index];
      if (!entry) return;

      const { task, attempt } = entry;

      const result =
        outcome.status === "fulfilled"
          ? AgentResult.parse(outcome.value)
          : resultFromThrow(task, outcome.reason);

      if (result.ok) {
        emit({ type: "task_completed", taskId: task.id, result });
        return;
      }

      const willRetry = attempt < maxAttempts;
      emit({
        type: "task_failed",
        taskId: task.id,
        error: result.error ?? "unknown failure",
        attempt,
        willRetry,
      });
    });
  }

  const finalState = board.state(plan);
  const failed = [...finalState.tasks.values()].filter((task) => task.status === "failed");
  const ok = failed.length === 0;

  // Until Phase 6's synthesizer, the answer is whatever the plan's sinks
  // produced. Honest, and enough to tell a finished run from an empty one.
  const finalOutput = sinkTasks(plan)
    .map((task) => finalState.tasks.get(task.id)?.result?.output)
    .filter((output): output is string => output !== undefined && output !== "")
    .join("\n");

  emit({
    type: "run_completed",
    ok,
    ...(finalOutput === "" ? {} : { finalOutput }),
  });

  const record = RunRecord.parse({
    runId,
    goal: plan.goal,
    planRevisions: [plan],
    events: [...board.events],
    totalTokens: {
      in: finalState.tokensIn + (options.priorUsage?.in ?? 0),
      out: finalState.tokensOut + (options.priorUsage?.out ?? 0),
    },
    costUsd: 0,
    ...(finalOutput === "" ? {} : { finalOutput }),
    startedAt,
    completedAt: now().toISOString(),
  });

  return { record, state: finalState, ok };
}

/** Convenience: the blast radius of every terminal failure in a finished run. */
export function blockedByFailures(plan: Plan, state: RunState): Map<string, string[]> {
  const blocked = new Map<string, string[]>();

  for (const [id, task] of state.tasks) {
    if (task.status !== "failed") continue;
    blocked.set(
      id,
      downstreamOf(plan, id).map((t) => t.id),
    );
  }

  return blocked;
}
