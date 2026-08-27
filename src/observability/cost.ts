/**
 * Token and cost accounting.
 *
 * A deliberate constraint runs through this module: **an unknown price is
 * reported as unknown, never as zero.** Silently pricing an unpriced model at
 * $0.00 would make a run look free, and a cost report that quietly
 * under-reports is worse than no cost report at all — you would trust it.
 *
 * Rates are therefore data, not a hard-coded assumption, and every result
 * carries whether it was actually priced.
 *
 * Phase 5 of ORCHESTRATOR_PLAN.md.
 */

import type { Event, RunRecord, TokenUsage } from "../kernel/schemas.js";

/** USD per one million tokens. */
export interface ModelRate {
  inPerMTok: number;
  outPerMTok: number;
  /** Where the figure came from, so a stale rate is traceable. */
  source: string;
}

export type RateTable = Record<string, ModelRate>;

/**
 * Known rates.
 *
 * Intentionally sparse. Model pricing changes and is not something to guess
 * at: a model absent from this table is reported unpriced rather than assigned
 * a plausible-looking number. Override per deployment with the environment
 * variables below, or by passing your own table.
 */
export const DEFAULT_RATES: RateTable = {};

export const RATE_ENV_IN = "LLM_PRICE_IN_PER_MTOK";
export const RATE_ENV_OUT = "LLM_PRICE_OUT_PER_MTOK";

/**
 * Builds a rate table from the environment.
 *
 * `LLM_PRICE_IN_PER_MTOK` / `LLM_PRICE_OUT_PER_MTOK` price whichever model the
 * run used, which is the common case: one model, rates you looked up today.
 */
export function ratesFromEnv(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
  base: RateTable = DEFAULT_RATES,
): RateTable {
  const inRaw = env[RATE_ENV_IN];
  const outRaw = env[RATE_ENV_OUT];
  if (inRaw === undefined || outRaw === undefined) return base;

  const inPerMTok = Number(inRaw);
  const outPerMTok = Number(outRaw);

  if (!Number.isFinite(inPerMTok) || !Number.isFinite(outPerMTok)) return base;
  if (inPerMTok < 0 || outPerMTok < 0) return base;

  return { ...base, [model]: { inPerMTok, outPerMTok, source: "environment" } };
}

export interface Cost {
  usd: number;
  /** False when no rate was known; `usd` is then 0 and means "not computed". */
  priced: boolean;
  model?: string;
}

export const UNPRICED: Cost = { usd: 0, priced: false };

/** Prices a token count. Returns `priced: false` when the model has no rate. */
export function costOf(
  usage: TokenUsage,
  model: string | undefined,
  rates: RateTable = DEFAULT_RATES,
): Cost {
  const rate = model === undefined ? undefined : rates[model];
  if (!rate) return model === undefined ? UNPRICED : { ...UNPRICED, model };

  const usd = (usage.in / 1_000_000) * rate.inPerMTok + (usage.out / 1_000_000) * rate.outPerMTok;

  return { usd, priced: true, model };
}

/* -------------------------------------------------------------------------- */
/* Per-task accounting                                                        */
/* -------------------------------------------------------------------------- */

export interface TaskUsage {
  taskId: string;
  agent: string | undefined;
  attempts: number;
  tokens: TokenUsage;
  cost: Cost;
  toolCalls: number;
}

/**
 * Token usage per task, read straight off the event log.
 *
 * Attempts are counted from `task_started` rather than from the result, so a
 * task that failed twice before succeeding shows all three attempts. Only
 * completed attempts report tokens, because a failure that never reached the
 * model did not spend any.
 */
export function usageByTask(
  events: readonly Event[],
  model: string | undefined,
  rates: RateTable = DEFAULT_RATES,
): TaskUsage[] {
  const byTask = new Map<string, TaskUsage>();

  const ensure = (taskId: string): TaskUsage => {
    const existing = byTask.get(taskId);
    if (existing) return existing;

    const created: TaskUsage = {
      taskId,
      agent: undefined,
      attempts: 0,
      tokens: { in: 0, out: 0 },
      cost: UNPRICED,
      toolCalls: 0,
    };
    byTask.set(taskId, created);
    return created;
  };

  for (const event of events) {
    switch (event.type) {
      case "task_started": {
        const entry = ensure(event.taskId);
        entry.attempts = Math.max(entry.attempts, event.attempt);
        entry.agent = event.agent;
        break;
      }

      case "task_completed": {
        const entry = ensure(event.taskId);
        entry.tokens.in += event.result.tokensIn;
        entry.tokens.out += event.result.tokensOut;
        entry.toolCalls += event.result.toolCalls.length;
        break;
      }

      case "task_failed":
      case "plan_created":
      case "replan":
      case "run_completed":
        break;
    }
  }

  for (const entry of byTask.values()) {
    entry.cost = costOf(entry.tokens, model, rates);
  }

  return [...byTask.values()];
}

/* -------------------------------------------------------------------------- */
/* Per-run accounting                                                         */
/* -------------------------------------------------------------------------- */

export interface RunCost {
  tokens: TokenUsage;
  cost: Cost;
  byTask: TaskUsage[];
  /**
   * Tokens spent outside any task — planning, replanning, classification.
   * Real money, and invisible if you only sum the tasks.
   */
  overhead: TokenUsage;
}

export function priceRun(
  record: RunRecord,
  model: string | undefined,
  rates: RateTable = DEFAULT_RATES,
): RunCost {
  const byTask = usageByTask(record.events, model, rates);

  const taskTotals = byTask.reduce<TokenUsage>(
    (sum, task) => ({ in: sum.in + task.tokens.in, out: sum.out + task.tokens.out }),
    { in: 0, out: 0 },
  );

  // Whatever the record totals hold beyond the tasks was spent planning or
  // routing. Clamped at zero so a hand-edited record cannot produce a
  // negative overhead that silently offsets a real cost.
  const overhead: TokenUsage = {
    in: Math.max(0, record.totalTokens.in - taskTotals.in),
    out: Math.max(0, record.totalTokens.out - taskTotals.out),
  };

  return {
    tokens: record.totalTokens,
    cost: costOf(record.totalTokens, model, rates),
    byTask,
    overhead,
  };
}

/** Formats a cost for display, distinguishing "free" from "unknown". */
export const formatCost = (cost: Cost): string =>
  cost.priced ? `$${cost.usd.toFixed(6)}` : "unpriced";
