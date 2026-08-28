/**
 * Routes a task to the specialist best able to perform it.
 *
 * Three sources of a decision, in descending order of confidence:
 *
 *   hint    — the planner already named a registered agent. Free and exact.
 *   llm     — ask a model, constrained to the registry's names.
 *   keyword — lexical scoring against each agent's declared cues.
 *
 * The keyword path is not merely a fallback for outages. It is what makes
 * routing testable: accuracy can be measured on a labelled set with no
 * network, and a regression in routing shows up as a number rather than a
 * vague sense that the agent got worse.
 *
 * Phase 4 of ORCHESTRATOR_PLAN.md.
 */

import type { AgentRegistry } from "../agents/registry.js";
import type { LlmClient } from "../llm/types.js";

import { extractJson } from "./json.js";
import type { Task } from "./schemas.js";

export type ClassificationSource = "hint" | "llm" | "keyword";

export interface Classification {
  agent: string;
  source: ClassificationSource;
  /** 0–1. For keyword routing, the winning agent's share of all matches. */
  confidence: number;
  reason: string;
}

export interface ClassifyOptions {
  registry: AgentRegistry;
  /** When absent, routing is keyword-only and fully deterministic. */
  llm?: LlmClient;
  /** Trust a planner-supplied `agentHint` that names a registered agent. */
  useHint?: boolean;
}

const normalise = (text: string): string => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;

/**
 * Scores each agent by how many of its keywords appear in the task.
 *
 * Whole-word matching only: "post" must not fire on "postcode", and "add" must
 * not fire on "address". Multi-word cues like "look up" are matched as
 * phrases.
 *
 * Regular plurals count as the same cue. Whole-word matching alone meant
 * "email" missed "notification emails" and "alert" missed "price alerts" —
 * a task was routed differently for writing its noun in the plural, which is
 * not a distinction any of these capabilities actually turn on. Only the
 * regular "+s"/"+es" forms are tried; this is not a stemmer, and irregular
 * plurals are still a vocabulary entry the agent has to declare.
 */
export function scoreAgents(task: Task, registry: AgentRegistry): Map<string, number> {
  const haystack = normalise(`${task.description} ${task.id.replace(/_/g, " ")}`);
  const scores = new Map<string, number>();

  for (const agent of registry.agents) {
    let score = 0;

    for (const keyword of agent.keywords) {
      const base = keyword.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const forms = [base, `${base}s`, `${base}es`];

      if (forms.some((form) => haystack.includes(` ${form} `))) score++;
    }

    scores.set(agent.name, score);
  }

  return scores;
}

/**
 * Deterministic routing. Always returns an agent: with no keyword match at
 * all, the first registered agent wins, and the zero confidence says so
 * honestly rather than dressing a guess up as a decision.
 */
export function keywordClassify(task: Task, registry: AgentRegistry): Classification {
  const scores = scoreAgents(task, registry);
  const total = [...scores.values()].reduce((sum, score) => sum + score, 0);

  let best = registry.names[0] ?? "";
  let bestScore = -1;

  // Registry order breaks ties, so the result never depends on Map iteration
  // order changing under us.
  //
  // Registry order puts the least-privileged agent first, and that is the safe
  // direction for an ambiguous tie. Breaking ties toward the *side-effecting*
  // agent was tried and reverted: "Check that the post arrived" scores research
  // and publish equally ("check" vs "post" as a noun), and routing it to
  // publish would hand `createPost` to a task that only reads. Withholding a
  // capability makes a task fail visibly; granting one it should not have fails
  // silently, which is far worse.
  for (const name of registry.names) {
    const score = scores.get(name) ?? 0;
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }

  if (total === 0) {
    return {
      agent: best,
      source: "keyword",
      confidence: 0,
      reason: "no keyword matched; defaulted to the first registered agent",
    };
  }

  return {
    agent: best,
    source: "keyword",
    confidence: bestScore / total,
    reason: `matched ${bestScore} of ${total} keyword hit(s)`,
  };
}

export const CLASSIFIER_SYSTEM_PROMPT = `You route one task to exactly one specialist agent.

Reply with JSON only:

{ "agent": "<agent name>", "reason": "<short justification>" }

Rules:
- "agent" must be exactly one of the names listed. Never invent a name.
- Choose by what the task actually does, not by words that merely appear in it.
- A task that reads or gathers information is research, even if the information will later be published.
- A task that transforms information already gathered is compute, including summarising and drafting.
- Only a task that writes to the outside world is publish.
- Output the JSON object and nothing else.`;

const buildPrompt = (task: Task, registry: AgentRegistry): string =>
  [
    "Agents:",
    registry.describe(),
    "",
    "Task:",
    `  id: ${task.id}`,
    `  description: ${task.description}`,
    "",
    "Which agent should perform it?",
  ].join("\n");

/**
 * Routes one task.
 *
 * An LLM answer naming an unregistered agent is discarded rather than trusted;
 * the keyword result stands in. A classifier that can invent a destination is
 * worse than one that is occasionally wrong, because the orchestrator would
 * dispatch into nothing.
 */
export async function classifyTask(
  task: Task,
  options: ClassifyOptions,
): Promise<Classification> {
  const { registry } = options;

  if (options.useHint !== false && task.agentHint !== undefined && registry.has(task.agentHint)) {
    return {
      agent: task.agentHint,
      source: "hint",
      confidence: 1,
      reason: "planner named a registered agent",
    };
  }

  if (!options.llm) return keywordClassify(task, registry);

  try {
    const response = await options.llm.generate({
      prompt: buildPrompt(task, registry),
      system: CLASSIFIER_SYSTEM_PROMPT,
      json: true,
      temperature: 0,
    });

    const parsed = extractJson(response.text) as { agent?: unknown; reason?: unknown };
    const agent = typeof parsed?.agent === "string" ? parsed.agent.trim() : "";

    if (registry.has(agent)) {
      return {
        agent,
        source: "llm",
        confidence: 1,
        reason: typeof parsed.reason === "string" && parsed.reason !== "" ? parsed.reason : "routed by model",
      };
    }
  } catch {
    // Fall through: an unavailable or malformed classifier must not stop a
    // run when a deterministic answer is available.
  }

  const fallback = keywordClassify(task, registry);
  return { ...fallback, reason: `${fallback.reason} (model answer unusable)` };
}

/** Adapts the classifier to the synchronous `Classifier` the orchestrator takes. */
export const keywordClassifier =
  (registry: AgentRegistry, useHint = true) =>
  (task: Task): string =>
    useHint && task.agentHint !== undefined && registry.has(task.agentHint)
      ? task.agentHint
      : keywordClassify(task, registry).agent;

/* -------------------------------------------------------------------------- */
/* Accuracy                                                                   */
/* -------------------------------------------------------------------------- */

export interface LabelledTask {
  id: string;
  description: string;
  expected: string;
}

export interface AccuracyReport {
  total: number;
  correct: number;
  accuracy: number;
  misroutes: { id: string; expected: string; got: string; reason: string }[];
  /** Per-expected-agent recall, so one weak class cannot hide in the average. */
  byAgent: Record<string, { total: number; correct: number }>;
}

export async function measureAccuracy(
  labelled: readonly LabelledTask[],
  options: ClassifyOptions,
): Promise<AccuracyReport> {
  const misroutes: AccuracyReport["misroutes"] = [];
  const byAgent: AccuracyReport["byAgent"] = {};
  let correct = 0;

  for (const item of labelled) {
    const bucket = (byAgent[item.expected] ??= { total: 0, correct: 0 });
    bucket.total++;

    const result = await classifyTask(
      { id: item.id, description: item.description, dependsOn: [], status: "pending", attempts: 0 },
      options,
    );

    if (result.agent === item.expected) {
      correct++;
      bucket.correct++;
    } else {
      misroutes.push({
        id: item.id,
        expected: item.expected,
        got: result.agent,
        reason: result.reason,
      });
    }
  }

  return {
    total: labelled.length,
    correct,
    accuracy: labelled.length === 0 ? 0 : correct / labelled.length,
    misroutes,
    byAgent,
  };
}
