/**
 * Typed contracts for the MCP-X orchestrator kernel.
 *
 * Every other kernel module (planner, scheduler, orchestrator, classifier,
 * replanner, blackboard) speaks in terms of these schemas. They are the single
 * source of truth: Zod validates at the boundary, TypeScript types are inferred
 * from the same declarations so the two can never drift.
 *
 * Phase 1 of ORCHESTRATOR_PLAN.md.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/** Stable identifier for a task within a single plan. */
export const TaskId = z.string().min(1, "task id must not be empty");

/** ISO-8601 timestamp. Kept as a string so records are trivially JSONL-able. */
export const Timestamp = z.string().datetime({ offset: true });

/**
 * Lifecycle of a task.
 *
 * `blocked` is distinct from `failed`: a task is blocked when an upstream
 * dependency failed, so it never got the chance to run. The orchestrator needs
 * that distinction to report an honest failure surface (one root cause, N
 * blocked descendants) rather than N indistinguishable failures.
 */
export const TaskStatus = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Terminal statuses - the orchestrator loop runs until every task is terminal. */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "blocked",
];

export const isTerminal = (status: TaskStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

/* -------------------------------------------------------------------------- */
/* Task                                                                        */
/* -------------------------------------------------------------------------- */

export const Task = z.object({
  id: TaskId,
  description: z.string().min(1, "a task must describe what it does"),
  /** Optional hint from the planner; the classifier may override it. */
  agentHint: z.string().min(1).optional(),
  dependsOn: z.array(TaskId).default([]),
  status: TaskStatus.default("pending"),
  attempts: z.number().int().min(0).default(0),
});

/** Fully-resolved task (defaults applied). */
export type Task = z.infer<typeof Task>;
/** Task as it may arrive from an LLM or fixture (defaults still optional). */
export type TaskInput = z.input<typeof Task>;

/* -------------------------------------------------------------------------- */
/* DAG validity                                                                */
/* -------------------------------------------------------------------------- */

type DagNode = { readonly id: string; readonly dependsOn: readonly string[] };

/**
 * Depth-first cycle detection over the dependency graph.
 *
 * Returns the cycle as a path with the entry node repeated at the end (e.g.
 * `["a", "b", "a"]`) so the validation error can name the offending loop
 * instead of just asserting one exists. Returns `null` for a valid DAG.
 *
 * Edges point from a task to each task it depends on. Unknown dependency ids
 * are skipped here - they are reported separately as unresolved references, so
 * one malformed plan yields both diagnostics rather than masking one another.
 */
export function findCycle(tasks: readonly DagNode[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;

  const colour = new Map<string, number>();
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const visit = (id: string): boolean => {
    const seen = colour.get(id) ?? WHITE;
    if (seen === BLACK) return false;
    if (seen === GREY) {
      // Re-entered a node still on the stack: everything from its first
      // appearance to here forms the cycle.
      const start = stack.indexOf(id);
      cycle = [...stack.slice(start), id];
      return true;
    }

    colour.set(id, GREY);
    stack.push(id);

    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }

    stack.pop();
    colour.set(id, BLACK);
    return false;
  };

  for (const task of tasks) {
    if (visit(task.id)) break;
  }

  return cycle;
}

/** Ids referenced in `dependsOn` that no task in the plan provides. */
export function findUnresolvedDependencies(
  tasks: readonly DagNode[],
): { taskId: string; missing: string }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const unresolved: { taskId: string; missing: string }[] = [];

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) unresolved.push({ taskId: task.id, missing: dep });
    }
  }

  return unresolved;
}

/** Ids that appear on more than one task. */
export function findDuplicateIds(tasks: readonly DagNode[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const task of tasks) {
    if (seen.has(task.id)) duplicates.add(task.id);
    seen.add(task.id);
  }

  return [...duplicates];
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

const PlanShape = z.object({
  goal: z.string().min(1, "a plan must state the goal it serves"),
  tasks: z.array(Task).min(1, "a plan must contain at least one task"),
  createdAt: Timestamp,
  /** 0 for the initial plan; incremented once per replan. */
  revision: z.number().int().min(0),
});

/**
 * A plan is a *validated* DAG. The refinement below is what makes this schema
 * worth having: an LLM will happily emit a task graph with a cycle or a
 * dangling dependency, and the orchestrator would deadlock on either.
 *
 * All three checks run and report together, so a single parse tells the planner
 * everything wrong with its output - which matters because the planner feeds
 * these errors back to the model on retry (Phase 2).
 */
export const Plan = PlanShape.superRefine((plan, ctx) => {
  for (const id of findDuplicateIds(plan.tasks)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tasks"],
      message: `duplicate task id: "${id}"`,
    });
  }

  for (const { taskId, missing } of findUnresolvedDependencies(plan.tasks)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tasks"],
      message: `task "${taskId}" depends on unknown task "${missing}"`,
    });
  }

  const cycle = findCycle(plan.tasks);
  if (cycle) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tasks"],
      message: `dependency cycle: ${cycle.join(" -> ")}`,
    });
  }
});

export type Plan = z.infer<typeof Plan>;
export type PlanInput = z.input<typeof Plan>;

/* -------------------------------------------------------------------------- */
/* Agent results                                                               */
/* -------------------------------------------------------------------------- */

export const ToolCall = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  ok: z.boolean(),
  durationMs: z.number().int().min(0).optional(),
  error: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * What a specialist agent hands back for one task.
 *
 * The refinement enforces the invariant the orchestrator relies on: a failure
 * always carries a reason. Without it, a silently-empty error turns into an
 * unexplained blocked subtree three phases later.
 */
export const AgentResult = z
  .object({
    taskId: TaskId,
    ok: z.boolean(),
    output: z.string().optional(),
    error: z.string().optional(),
    toolCalls: z.array(ToolCall).default([]),
    tokensIn: z.number().int().min(0).default(0),
    tokensOut: z.number().int().min(0).default(0),
  })
  .superRefine((result, ctx) => {
    if (result.ok && result.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "a successful result must not carry an error",
      });
    }

    if (!result.ok && !result.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "a failed result must explain why it failed",
      });
    }
  });

export type AgentResult = z.infer<typeof AgentResult>;
export type AgentResultInput = z.input<typeof AgentResult>;

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

const eventBase = {
  runId: z.string().min(1),
  at: Timestamp,
};

/**
 * The append-only event log. A RunRecord is replayable precisely because these
 * events carry enough detail to reconstruct state without re-running anything.
 *
 * A discriminated union (rather than a loose `{ type, payload }`) means an
 * exhaustive `switch` over `event.type` is checked by the compiler - adding a
 * seventh event type breaks every consumer that has not handled it, which is
 * exactly where we want that failure: compile time, not replay time.
 */
export const Event = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("plan_created"),
    revision: z.number().int().min(0),
    taskCount: z.number().int().min(1),
  }),
  z.object({
    ...eventBase,
    type: z.literal("task_started"),
    taskId: TaskId,
    /** Which specialist the classifier routed this task to. */
    agent: z.string().min(1),
    attempt: z.number().int().min(1),
  }),
  z.object({
    ...eventBase,
    type: z.literal("task_completed"),
    taskId: TaskId,
    result: AgentResult,
  }),
  z.object({
    ...eventBase,
    type: z.literal("task_failed"),
    taskId: TaskId,
    error: z.string().min(1),
    attempt: z.number().int().min(1),
    willRetry: z.boolean(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("replan"),
    fromRevision: z.number().int().min(0),
    toRevision: z.number().int().min(1),
    reason: z.string().min(1),
    triggeredByTaskId: TaskId.optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run_completed"),
    ok: z.boolean(),
    finalOutput: z.string().optional(),
  }),
]);

export type Event = z.infer<typeof Event>;
export type EventType = Event["type"];

/* -------------------------------------------------------------------------- */
/* Run record                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Input and output tokens are tracked separately because they are billed at
 * different rates - a single scalar total cannot produce a correct cost.
 */
export const TokenUsage = z.object({
  in: z.number().int().min(0).default(0),
  out: z.number().int().min(0).default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

const RunRecordShape = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  /**
   * Append-only plan history. Index 0 is the planner's first attempt; each
   * replan appends a revision rather than mutating the previous one, so the
   * record shows what changed and why (Phase 6).
   */
  planRevisions: z.array(Plan).min(1, "a run must have at least one plan"),
  events: z.array(Event).default([]),
  totalTokens: TokenUsage.default({ in: 0, out: 0 }),
  costUsd: z.number().min(0).default(0),
  finalOutput: z.string().optional(),
  startedAt: Timestamp,
  completedAt: Timestamp.optional(),
});

/**
 * Invariants that make a record trustworthy as an audit trail: revisions are
 * contiguous and ordered, every revision serves the same goal, and no event
 * from another run has leaked in.
 */
export const RunRecord = RunRecordShape.superRefine((run, ctx) => {
  const firstOutOfOrder = run.planRevisions.findIndex(
    (revision, index) => revision.revision !== index,
  );

  if (firstOutOfOrder !== -1) {
    const actual = run.planRevisions[firstOutOfOrder]?.revision;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["planRevisions", firstOutOfOrder, "revision"],
      message: `plan revisions must be contiguous from 0; expected ${firstOutOfOrder}, got ${actual}`,
    });
  }

  for (const [index, revision] of run.planRevisions.entries()) {
    if (revision.goal !== run.goal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["planRevisions", index, "goal"],
        message: "every plan revision must serve the run's goal",
      });
    }
  }

  for (const [index, event] of run.events.entries()) {
    if (event.runId !== run.runId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["events", index, "runId"],
        message: `event belongs to run "${event.runId}", not "${run.runId}"`,
      });
    }
  }
});

export type RunRecord = z.infer<typeof RunRecord>;
export type RunRecordInput = z.input<typeof RunRecord>;
