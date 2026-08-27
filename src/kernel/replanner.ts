/**
 * Bounded adaptive replanning.
 *
 * When a task fails terminally, the run does not have to end. The replanner is
 * given what succeeded, what failed and why, and asked for an alternate route
 * to the same goal — within a hard cap, so a plan that cannot work fails in
 * bounded time instead of looping.
 *
 * Two constraints fall out of the event-sourced design and are enforced here
 * rather than hoped for:
 *
 *   Completed work must carry forward. State is derived by replaying events
 *   over the *current* plan, so a completed task keeps its result only while
 *   its id survives into the new revision. Drop the id and the work is
 *   silently redone.
 *
 *   The failed task's id must NOT reappear. Its `task_failed` event is still
 *   in the log and would be replayed against the new plan, marking the task
 *   failed again the instant it is added — an alternate path built on the same
 *   id can never run.
 *
 * Phase 6 of ORCHESTRATOR_PLAN.md.
 */

import type { LlmClient } from "../llm/types.js";

import type { RunState } from "./blackboard.js";
import { extractJson, JsonExtractionError } from "./json.js";
import { Plan, type PlanInput, type Task } from "./schemas.js";

export const DEFAULT_MAX_REPLANS = 2;
export const DEFAULT_MAX_REPLAN_ATTEMPTS = 3;

export interface ReplanContext {
  goal: string;
  /** The revision that was running when the failure happened. */
  plan: Plan;
  state: RunState;
  failedTaskId: string;
  error: string;
}

export interface ReplanAttempt {
  attempt: number;
  raw: string;
  errors: string[];
  tokensIn: number;
  tokensOut: number;
}

export interface ReplanResult {
  plan: Plan;
  reason: string;
  attempts: ReplanAttempt[];
  tokensIn: number;
  tokensOut: number;
}

export class ReplanError extends Error {
  readonly attempts: ReplanAttempt[];

  constructor(message: string, attempts: ReplanAttempt[] = []) {
    super(message);
    this.name = "ReplanError";
    this.attempts = attempts;
  }
}

/** Tasks that finished successfully in the current revision. */
export const carriedForward = (plan: Plan, state: RunState): Task[] =>
  plan.tasks.filter((task) => state.tasks.get(task.id)?.status === "completed");

/**
 * Validates a proposed revision against the two invariants above.
 *
 * Returns human-readable problems, empty when the revision is sound. The
 * strings go back to the model on retry, so they say what to do rather than
 * merely what is wrong.
 */
export function validateRevision(
  next: Plan,
  context: ReplanContext,
): string[] {
  const problems: string[] = [];
  const nextIds = new Set(next.tasks.map((task) => task.id));

  for (const completed of carriedForward(context.plan, context.state)) {
    if (!nextIds.has(completed.id)) {
      problems.push(
        `task "${completed.id}" already completed successfully and must be kept, unchanged, in the new plan`,
      );
    }
  }

  if (nextIds.has(context.failedTaskId)) {
    problems.push(
      `task "${context.failedTaskId}" already failed and must not appear again; give the alternate route a different id`,
    );
  }

  if (next.revision !== context.plan.revision + 1) {
    problems.push(
      `revision must be ${context.plan.revision + 1}, not ${next.revision}`,
    );
  }

  const completedIds = new Set(carriedForward(context.plan, context.state).map((t) => t.id));
  const addsWork = next.tasks.some((task) => !completedIds.has(task.id));
  if (!addsWork) {
    problems.push("the new plan adds no new work, so the goal can never be reached");
  }

  return problems;
}

export const REPLANNER_SYSTEM_PROMPT = `You repair a failed plan for an autonomous agent system.

A task has failed and cannot be retried. Produce a REPLACEMENT set of tasks that reaches the same goal by a different route.

Reply with JSON only:

{
  "reason": "<one sentence: why the old route failed and what the new one does differently>",
  "tasks": [
    { "id": "snake_case_id", "description": "...", "agentHint": "research" | "compute" | "publish", "dependsOn": ["..."] }
  ]
}

Rules:
- Include every already-completed task exactly as given, with the same id and the same dependsOn. Their results are reused; re-running them wastes work.
- Do NOT include the failed task's id. It already failed and would fail again. Give the alternate route new ids.
- The alternate route must genuinely differ from what failed. Repeating the same approach under a new name is not a repair.
- The graph must be acyclic and every dependsOn must reference a task in this list.
- Output the JSON object and nothing else.`;

const buildPrompt = (context: ReplanContext): string => {
  const completed = carriedForward(context.plan, context.state);
  const blocked = context.plan.tasks.filter(
    (task) => context.state.tasks.get(task.id)?.status === "blocked",
  );

  return [
    `Goal: ${context.goal}`,
    "",
    "Already completed (keep these exactly, with these ids):",
    ...(completed.length > 0
      ? completed.map(
          (task) =>
            `  - ${task.id} (dependsOn: ${task.dependsOn.join(", ") || "none"}): ${task.description}`,
        )
      : ["  (none)"]),
    "",
    `Failed and unusable: ${context.failedTaskId}`,
    `  reason: ${context.error}`,
    "",
    "Never ran because they depended on the failure:",
    ...(blocked.length > 0
      ? blocked.map((task) => `  - ${task.id}: ${task.description}`)
      : ["  (none)"]),
    "",
    "Produce the replacement plan.",
  ].join("\n");
};

const buildRepairPrompt = (context: ReplanContext, raw: string, errors: string[]): string =>
  [
    buildPrompt(context),
    "",
    "Your previous response was rejected. You returned:",
    raw.length > 2000 ? `${raw.slice(0, 2000)}...` : raw,
    "",
    "It failed validation for these reasons:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Return a corrected JSON object. Fix every problem listed above.",
  ].join("\n");

export interface ReplannerOptions {
  llm: LlmClient;
  /** Schema-repair attempts within a single replan. */
  maxAttempts?: number;
  now?: () => Date;
}

/**
 * Asks the model for an alternate route.
 *
 * @throws {ReplanError} when no attempt produced a sound revision.
 */
export async function createReplan(
  context: ReplanContext,
  options: ReplannerOptions,
): Promise<ReplanResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_REPLAN_ATTEMPTS;
  const now = options.now ?? (() => new Date());
  const attempts: ReplanAttempt[] = [];

  let prompt = buildPrompt(context);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await options.llm.generate({
      prompt,
      system: REPLANNER_SYSTEM_PROMPT,
      json: true,
      temperature: 0,
    });

    const errors: string[] = [];
    let candidate: Plan | null = null;
    let reason = "";

    try {
      const parsed = extractJson(response.text) as { tasks?: unknown; reason?: unknown };
      reason = typeof parsed?.reason === "string" ? parsed.reason : "";

      const proposal: PlanInput = {
        goal: context.goal,
        tasks: (parsed?.tasks ?? []) as PlanInput["tasks"],
        createdAt: now().toISOString(),
        revision: context.plan.revision + 1,
      };

      const validated = Plan.safeParse(proposal);
      if (validated.success) {
        candidate = validated.data;
        errors.push(...validateRevision(candidate, context));
      } else {
        errors.push(
          ...validated.error.issues.map((issue) => {
            const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
            return `${where}${issue.message}`;
          }),
        );
      }
    } catch (error) {
      errors.push(
        error instanceof JsonExtractionError
          ? "Response was not valid JSON. Return a single JSON object and nothing else."
          : `Could not read the response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    attempts.push({
      attempt,
      raw: response.text,
      errors,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
    });

    if (candidate !== null && errors.length === 0) {
      return {
        plan: candidate,
        reason:
          reason === "" ? `alternate route after "${context.failedTaskId}" failed` : reason,
        attempts,
        tokensIn: attempts.reduce((sum, a) => sum + a.tokensIn, 0),
        tokensOut: attempts.reduce((sum, a) => sum + a.tokensOut, 0),
      };
    }

    prompt = buildRepairPrompt(context, response.text, errors);
  }

  throw new ReplanError(
    `Replanner failed to produce a usable revision in ${maxAttempts} attempt(s): ${
      attempts.at(-1)?.errors.join("; ") ?? "unknown"
    }`,
    attempts,
  );
}

/** Adapts {@link createReplan} to the hook the orchestrator takes. */
export const llmReplanner =
  (options: ReplannerOptions) =>
  async (
    context: ReplanContext,
  ): Promise<{ plan: Plan; reason: string; tokensIn: number; tokensOut: number }> => {
    const result = await createReplan(context, options);
    return {
      plan: result.plan,
      reason: result.reason,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    };
  };
