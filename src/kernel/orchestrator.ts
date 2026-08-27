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
import type { ReplanContext } from "./replanner.js";
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
export const DEFAULT_MAX_REPLANS = 2;

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
   * Called for each plan revision, including the initial one, as it takes
   * effect. A log writer needs this: the `replan` event records that a repair
   * happened, but deliberately does not carry the plan itself — duplicating
   * every task into the event stream would bloat the log for no gain.
   */
  onPlanRevision?: (plan: Plan) => void;
  /**
   * Tokens already spent before execution began — planning, replanning,
   * routing. Added to the run totals.
   *
   * Without this the record would sum only what tasks consumed, quietly
   * omitting the planner's spend. That is real money, and a cost report that
   * under-reports is worse than none because it gets trusted.
   */
  priorUsage?: TokenUsage;
  /**
   * Repairs the plan after a terminal task failure. Omit to disable
   * replanning, in which case a failure blocks its subtree and the run ends.
   */
  replan?: (context: ReplanContext) => Promise<{ plan: Plan; reason: string }>;
  /**
   * Hard cap on repairs per run. The bound is the point: without it, a goal
   * that cannot be reached would produce plans forever.
   */
  maxReplans?: number;
  /** Reports a replanner that threw. The run then ends with its existing failure. */
  onReplanError?: (error: unknown, context: ReplanContext) => void;
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
  const { execute } = options;
  const classify = options.classify ?? defaultClassifier;
  const maxAttempts = options.maxAttemptsPerTask ?? DEFAULT_MAX_TASK_ATTEMPTS;
  const maxReplans = options.maxReplans ?? DEFAULT_MAX_REPLANS;
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? `run-${now().getTime().toString(36)}`;

  const board = new Blackboard(runId, { now });
  const startedAt = now().toISOString();

  // Revisions are appended, never mutated, so the record shows what changed.
  const revisions: Plan[] = [options.plan];
  let plan = options.plan;
  let replansUsed = 0;

  const emit = (event: Parameters<Blackboard["append"]>[0]): void => {
    const appended = board.append(event);
    options.onEvent?.(appended);
  };

  options.onPlanRevision?.(plan);
  emit({ type: "plan_created", revision: plan.revision, taskCount: plan.tasks.length });

  for (;;) {
    const state = board.state(plan);

    const unfinished = [...state.tasks.values()].filter(
      (task) => task.status === "pending" || task.status === "running",
    );

    if (unfinished.length === 0) {
      // Everything is terminal. If something failed and repairs remain, try an
      // alternate route before calling the run over.
      const failed = [...state.tasks.values()].find((task) => task.status === "failed");
      if (!options.replan || !failed || replansUsed >= maxReplans) break;

      const context: ReplanContext = {
        goal: plan.goal,
        plan,
        state,
        failedTaskId: failed.id,
        error: failed.error ?? "unknown failure",
      };

      let repaired;
      try {
        repaired = await options.replan(context);
      } catch (error) {
        // A replanner that cannot produce a route is not a crash; the run ends
        // with the failure it already had. But it is reported rather than
        // swallowed — silence here is indistinguishable from having no
        // replanner at all, which is exactly the wrong thing to debug blind.
        options.onReplanError?.(error, context);
        break;
      }

      replansUsed++;
      emit({
        type: "replan",
        fromRevision: plan.revision,
        toRevision: repaired.plan.revision,
        reason: repaired.reason,
        triggeredByTaskId: failed.id,
      });

      plan = repaired.plan;
      revisions.push(plan);
      options.onPlanRevision?.(plan);
      continue;
    }

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
    planRevisions: revisions,
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
