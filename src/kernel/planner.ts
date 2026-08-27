/**
 * Goal -> validated task DAG.
 *
 * The planner is the first place non-determinism enters the system, so it is
 * built around the assumption that the model will sometimes be wrong: it asks
 * for JSON, validates against the `Plan` schema, and on failure hands the
 * validation errors back to the model and asks again, up to a hard cap.
 *
 * This is why `Plan` reports every structural problem in one parse rather than
 * short-circuiting on the first. Each retry costs a model round-trip, so one
 * round-trip should fix every defect, not just the earliest one.
 *
 * Phase 2 of ORCHESTRATOR_PLAN.md.
 */

import type { LlmClient } from "../llm/types.js";

import { extractJson, JsonExtractionError } from "./json.js";
import { Plan, type PlanInput } from "./schemas.js";

export const DEFAULT_MAX_PLAN_ATTEMPTS = 3;

export const PLANNER_SYSTEM_PROMPT = `You are the planning stage of an autonomous agent system.

You decompose a user's goal into a directed acyclic graph (DAG) of small, concrete tasks that specialist agents will execute.

Reply with JSON only, matching exactly this shape:

{
  "tasks": [
    {
      "id": "snake_case_identifier",
      "description": "one imperative sentence describing the work",
      "agentHint": "research" | "compute" | "publish",
      "dependsOn": ["id_of_a_prerequisite_task"]
    }
  ]
}

Rules:
- Every id must be unique, and every entry in dependsOn must be the id of another task in this same list.
- The graph must be acyclic. A task must never depend on itself, directly or transitively.
- A task that needs no prerequisite has "dependsOn": [].
- Tasks that could run at the same time must NOT depend on each other. Express real data dependencies only, not a preferred order.
- Prefer 3 to 8 tasks. Each should be one unit of work a single agent can perform.
- agentHint is your best guess at the specialist: "research" gathers information, "compute" transforms or calculates, "publish" writes to the outside world.
- Output the JSON object and nothing else. No markdown fences, no commentary.`;

/** What the model is asked to return: the task list only. */
interface PlannerOutput {
  tasks: unknown;
}

export interface PlannerOptions {
  llm: LlmClient;
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Injectable clock so `createdAt` is deterministic in tests. */
  now?: () => Date;
}

export interface PlanAttempt {
  attempt: number;
  raw: string;
  /** Empty when the attempt produced a valid plan. */
  errors: string[];
  tokensIn: number;
  tokensOut: number;
}

export interface PlannerResult {
  plan: Plan;
  /** Every attempt made, including the successful one. Length > 1 means repair happened. */
  attempts: PlanAttempt[];
  tokensIn: number;
  tokensOut: number;
}

export class PlannerError extends Error {
  readonly attempts: PlanAttempt[];
  readonly tokensIn: number;
  readonly tokensOut: number;

  constructor(message: string, attempts: PlanAttempt[]) {
    super(message);
    this.name = "PlannerError";
    this.attempts = attempts;
    this.tokensIn = attempts.reduce((sum, a) => sum + a.tokensIn, 0);
    this.tokensOut = attempts.reduce((sum, a) => sum + a.tokensOut, 0);
  }
}

const buildInitialPrompt = (goal: string): string =>
  `Goal: ${goal}\n\nProduce the task DAG as JSON.`;

/**
 * Repair prompt. It restates what the model produced and exactly what was
 * wrong, because a bare "that was invalid, try again" tends to produce the
 * same output a second time.
 */
const buildRepairPrompt = (goal: string, raw: string, errors: string[]): string =>
  [
    `Goal: ${goal}`,
    "",
    "Your previous response was rejected. You returned:",
    raw.length > 2000 ? `${raw.slice(0, 2000)}...` : raw,
    "",
    "It failed validation for these reasons:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Return a corrected JSON object in the required shape. Fix every problem listed above.",
  ].join("\n");

/** Renders Zod issues as human-readable lines the model can act on. */
const describeIssues = (issues: readonly { path: (string | number)[]; message: string }[]) =>
  issues.map((issue) => {
    const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${where}${issue.message}`;
  });

/**
 * Decomposes `goal` into a validated {@link Plan}.
 *
 * @throws {PlannerError} when no attempt within the cap produced a valid DAG.
 */
export async function createPlan(
  goal: string,
  options: PlannerOptions,
): Promise<PlannerResult> {
  const trimmedGoal = goal.trim();
  if (trimmedGoal === "") {
    throw new PlannerError("Cannot plan for an empty goal", []);
  }

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_PLAN_ATTEMPTS;
  const now = options.now ?? (() => new Date());
  const attempts: PlanAttempt[] = [];

  let prompt = buildInitialPrompt(trimmedGoal);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await options.llm.generate({
      prompt,
      system: PLANNER_SYSTEM_PROMPT,
      json: true,
      temperature: 0,
    });

    const errors = [] as string[];
    let candidate: PlanInput | null = null;

    try {
      const parsed = extractJson(response.text) as PlannerOutput;
      candidate = {
        goal: trimmedGoal,
        tasks: (parsed?.tasks ?? []) as PlanInput["tasks"],
        createdAt: now().toISOString(),
        revision: 0,
      };
    } catch (error) {
      errors.push(
        error instanceof JsonExtractionError
          ? "Response was not valid JSON. Return a single JSON object and nothing else."
          : `Could not read the response: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    }

    if (candidate !== null) {
      const validated = Plan.safeParse(candidate);

      if (validated.success) {
        attempts.push({
          attempt,
          raw: response.text,
          errors: [],
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
        });

        return {
          plan: validated.data,
          attempts,
          tokensIn: attempts.reduce((sum, a) => sum + a.tokensIn, 0),
          tokensOut: attempts.reduce((sum, a) => sum + a.tokensOut, 0),
        };
      }

      errors.push(...describeIssues(validated.error.issues));
    }

    attempts.push({
      attempt,
      raw: response.text,
      errors,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
    });

    prompt = buildRepairPrompt(trimmedGoal, response.text, errors);
  }

  const lastErrors = attempts.at(-1)?.errors ?? [];
  throw new PlannerError(
    `Planner failed to produce a valid plan in ${maxAttempts} attempt(s). Last errors: ${lastErrors.join(
      "; ",
    )}`,
    attempts,
  );
}
