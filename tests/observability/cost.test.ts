import { describe, expect, it } from "vitest";

import { runPlan } from "@kernel/orchestrator";
import { Plan, type Event } from "@kernel/schemas";
import {
  costOf,
  DEFAULT_RATES,
  formatCost,
  priceRun,
  ratesFromEnv,
  UNPRICED,
  usageByTask,
  type RateTable,
} from "@obs/cost";

const AT = "2026-08-27T10:00:00.000Z";
const now = () => new Date(AT);

const RATES: RateTable = {
  "test-model": { inPerMTok: 10, outPerMTok: 40, source: "test" },
};

const plan = Plan.parse({
  goal: "ship the thing",
  tasks: [
    { id: "a", description: "do a", dependsOn: [] },
    { id: "b", description: "do b", dependsOn: ["a"] },
  ],
  createdAt: AT,
  revision: 0,
});

const started = (taskId: string, attempt = 1): Event => ({
  type: "task_started",
  runId: "run-1",
  at: AT,
  taskId,
  agent: "compute",
  attempt,
});

const completed = (taskId: string, tokensIn: number, tokensOut: number, tools = 0): Event => ({
  type: "task_completed",
  runId: "run-1",
  at: AT,
  taskId,
  result: {
    taskId,
    ok: true,
    toolCalls: Array.from({ length: tools }, () => ({ tool: "t", args: {}, ok: true })),
    tokensIn,
    tokensOut,
  },
});

/* -------------------------------------------------------------------------- */

describe("costOf", () => {
  it("prices a known model", () => {
    // 1M in at $10 + 1M out at $40.
    const cost = costOf({ in: 1_000_000, out: 1_000_000 }, "test-model", RATES);

    expect(cost.priced).toBe(true);
    expect(cost.usd).toBeCloseTo(50, 10);
  });

  it("prices fractional usage", () => {
    const cost = costOf({ in: 1000, out: 500 }, "test-model", RATES);

    expect(cost.usd).toBeCloseTo(0.01 + 0.02, 10);
  });

  it("reports an unknown model as unpriced rather than free", () => {
    const cost = costOf({ in: 1_000_000, out: 1_000_000 }, "mystery-model", RATES);

    // The whole point: $0.00 would read as "this run was free", and a cost
    // report that quietly under-reports is worse than none because it is
    // trusted.
    expect(cost.priced).toBe(false);
    expect(cost.usd).toBe(0);
    expect(cost.model).toBe("mystery-model");
  });

  it("reports unpriced when no model is known at all", () => {
    expect(costOf({ in: 10, out: 10 }, undefined, RATES)).toEqual(UNPRICED);
  });

  it("ships no default rates, so nothing is priced by accident", () => {
    // Model prices change and are not something to guess at.
    expect(Object.keys(DEFAULT_RATES)).toEqual([]);
    expect(costOf({ in: 1000, out: 1000 }, "gemini-3.6-flash").priced).toBe(false);
  });

  it("prices zero usage as zero", () => {
    expect(costOf({ in: 0, out: 0 }, "test-model", RATES)).toMatchObject({
      usd: 0,
      priced: true,
    });
  });
});

describe("formatCost", () => {
  it("distinguishes a real zero from an unknown price", () => {
    expect(formatCost({ usd: 0, priced: true })).toBe("$0.000000");
    expect(formatCost(UNPRICED)).toBe("unpriced");
  });
});

describe("ratesFromEnv", () => {
  it("builds a rate for the named model", () => {
    const rates = ratesFromEnv("m", {
      LLM_PRICE_IN_PER_MTOK: "3",
      LLM_PRICE_OUT_PER_MTOK: "12",
    });

    expect(rates["m"]).toMatchObject({ inPerMTok: 3, outPerMTok: 12 });
  });

  it("returns the base table when either variable is missing", () => {
    expect(ratesFromEnv("m", { LLM_PRICE_IN_PER_MTOK: "3" })).toEqual(DEFAULT_RATES);
    expect(ratesFromEnv("m", {})).toEqual(DEFAULT_RATES);
  });

  it("ignores non-numeric or negative values rather than pricing wrongly", () => {
    for (const [i, o] of [
      ["abc", "12"],
      ["3", "xyz"],
      ["-1", "12"],
      ["3", "-1"],
    ]) {
      const rates = ratesFromEnv("m", {
        LLM_PRICE_IN_PER_MTOK: i,
        LLM_PRICE_OUT_PER_MTOK: o,
      });
      expect(rates["m"], `${i}/${o}`).toBeUndefined();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("usageByTask", () => {
  it("attributes tokens to the task that spent them", () => {
    const usage = usageByTask(
      [started("a"), completed("a", 100, 50), started("b"), completed("b", 20, 10)],
      "test-model",
      RATES,
    );

    expect(usage.find((u) => u.taskId === "a")?.tokens).toEqual({ in: 100, out: 50 });
    expect(usage.find((u) => u.taskId === "b")?.tokens).toEqual({ in: 20, out: 10 });
  });

  it("records the agent that ran each task", () => {
    const usage = usageByTask([started("a"), completed("a", 1, 1)], "test-model", RATES);

    expect(usage[0]?.agent).toBe("compute");
  });

  it("counts every attempt, not just the successful one", () => {
    const usage = usageByTask(
      [started("a", 1), started("a", 2), started("a", 3), completed("a", 10, 5)],
      "test-model",
      RATES,
    );

    expect(usage[0]?.attempts).toBe(3);
  });

  it("counts tool calls", () => {
    const usage = usageByTask([started("a"), completed("a", 1, 1, 3)], "test-model", RATES);

    expect(usage[0]?.toolCalls).toBe(3);
  });

  it("prices each task individually", () => {
    const usage = usageByTask([completed("a", 1_000_000, 0)], "test-model", RATES);

    expect(usage[0]?.cost.usd).toBeCloseTo(10, 10);
  });

  it("returns nothing for an empty log", () => {
    expect(usageByTask([], "test-model", RATES)).toEqual([]);
  });
});

describe("priceRun", () => {
  it("separates task spend from planning overhead", async () => {
    const outcome = await runPlan({
      plan,
      runId: "run-1",
      now,
      // 300/150 spent planning before execution started.
      priorUsage: { in: 300, out: 150 },
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok", tokensIn: 10, tokensOut: 5 }),
    });

    const priced = priceRun(outcome.record, "test-model", RATES);

    // Two tasks at 10/5 each, plus the planner's 300/150.
    expect(priced.tokens).toEqual({ in: 320, out: 160 });
    expect(priced.overhead).toEqual({ in: 300, out: 150 });
  });

  it("reports zero overhead when everything is attributable", async () => {
    const outcome = await runPlan({
      plan,
      runId: "run-1",
      now,
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok", tokensIn: 10, tokensOut: 5 }),
    });

    expect(priceRun(outcome.record, "test-model", RATES).overhead).toEqual({ in: 0, out: 0 });
  });

  it("clamps overhead at zero rather than letting it offset real cost", async () => {
    const outcome = await runPlan({
      plan,
      runId: "run-1",
      now,
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok", tokensIn: 10, tokensOut: 5 }),
    });

    // Simulate a hand-edited record whose totals are lower than its events.
    const tampered = { ...outcome.record, totalTokens: { in: 0, out: 0 } };

    expect(priceRun(tampered, "test-model", RATES).overhead).toEqual({ in: 0, out: 0 });
  });

  it("marks the whole run unpriced for an unknown model", async () => {
    const outcome = await runPlan({
      plan,
      runId: "run-1",
      now,
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok" }),
    });

    expect(priceRun(outcome.record, "mystery", RATES).cost.priced).toBe(false);
  });
});

describe("orchestrator priorUsage", () => {
  it("adds pre-execution spend to the run totals", async () => {
    const outcome = await runPlan({
      plan,
      runId: "run-1",
      now,
      priorUsage: { in: 7, out: 3 },
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok" }),
    });

    // Without this the planner's spend would silently vanish from the record.
    expect(outcome.record.totalTokens).toEqual({ in: 7, out: 3 });
  });

  it("defaults to zero when omitted", async () => {
    const outcome = await runPlan({
      plan,
      runId: "run-1",
      now,
      execute: (task) => ({ taskId: task.id, ok: true, output: "ok" }),
    });

    expect(outcome.record.totalTokens).toEqual({ in: 0, out: 0 });
  });
});
