/**
 * Scoring for the evaluation harness.
 *
 * Every function here is pure. The harness measures a non-deterministic
 * system, so the *measurement* had better be deterministic — otherwise a
 * moving number tells you nothing about which of the two moved.
 *
 * Two decisions come from findings recorded in earlier phases:
 *
 *   A run's signature never includes task ids. Three live runs of the same
 *   goal produced identical structure with different ids every time
 *   (`post_to_twitter` / `post_summary_to_twitter` / `post_tweet`). Keying
 *   variance on ids would report pure noise as instability.
 *
 *   Parallelism is scored per scenario, not globally. Some goals decompose
 *   into a chain and some into a branch, and which one you get depends on the
 *   goal rather than on a general habit of the model.
 *
 * Phase 7 of ORCHESTRATOR_PLAN.md.
 */

import { z } from "zod";

import { Capability } from "../src/mcp/tools.js";

/* -------------------------------------------------------------------------- */
/* Scenario                                                                   */
/* -------------------------------------------------------------------------- */

export const Scenario = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  /** Capabilities a competent plan must use. */
  expectedCapabilities: z.array(Capability).min(1),
  /** The capability the plan must end on, when the goal implies one. */
  terminalCapability: Capability.optional(),
  /** Fewest tasks a good plan needs. Denominator for step efficiency. */
  optimalSteps: z.number().int().min(1),
  /** Above this, the plan is padded. A run exceeding it fails the scenario. */
  maxSteps: z.number().int().min(1),
  notes: z.string().optional(),
});
export type Scenario = z.infer<typeof Scenario>;

/* -------------------------------------------------------------------------- */
/* Observation                                                                */
/* -------------------------------------------------------------------------- */

/** What one execution of one scenario produced. */
export interface RunObservation {
  ok: boolean;
  /** 1 means the planner's first output was a valid DAG. */
  planAttempts: number;
  taskCount: number;
  /** Waves the plan would execute in; 1 wave with N tasks is full parallelism. */
  waveCount: number;
  /** Routed capability per task, in plan order. */
  capabilities: string[];
  replans: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
}

/**
 * A structural fingerprint of a run.
 *
 * Task ids are deliberately excluded — see the module note. Two runs share a
 * signature when they decomposed the goal the same way, whatever they chose
 * to call the steps.
 */
export const signatureOf = (observation: RunObservation): string =>
  [
    `n=${observation.taskCount}`,
    `w=${observation.waveCount}`,
    `caps=${observation.capabilities.join(">")}`,
  ].join(" ");

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

export interface Thresholds {
  completionRate: number;
  capabilityRecall: number;
  capabilityPrecision: number;
  planValidityRate: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  completionRate: 1,
  capabilityRecall: 1,
  /**
   * Precision is gated, not merely reported. Recall alone asks "did it do
   * everything the goal needs" and a padded plan passes that trivially —
   * routing a trivial arithmetic goal through `research` scores full recall
   * while doing work nobody asked for.
   */
  capabilityPrecision: 0.8,
  planValidityRate: 0.67,
};

export interface ScenarioMetrics {
  runs: number;
  completionRate: number;
  planValidityRate: number;
  capabilityPrecision: number;
  capabilityRecall: number;
  capabilityF1: number;
  terminalCorrectRate: number;
  /** optimalSteps / mean task count, capped at 1. Lower means padded plans. */
  stepEfficiency: number;
  withinMaxStepsRate: number;
  replanRate: number;
  meanTokensIn: number;
  meanTokensOut: number;
  meanDurationMs: number;
  /** Distinct structural signatures across the repeats. */
  signatures: string[];
  /** True when every repeat decomposed the goal identically. */
  stable: boolean;
  pass: boolean;
  failures: string[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

const rate = (matching: number, total: number): number => (total === 0 ? 0 : matching / total);

/**
 * Precision and recall of routed capabilities against the scenario's
 * expectation, computed on sets rather than counts.
 *
 * Set-based is the right call: a plan using `research` four times has not used
 * it four times "correctly", it has used one capability. Counting occurrences
 * would reward padding.
 */
export function capabilityScores(
  observations: readonly RunObservation[],
  expected: readonly string[],
): { precision: number; recall: number; f1: number } {
  const expectedSet = new Set(expected);

  const perRun = observations.map((observation) => {
    const used = new Set(observation.capabilities);
    if (used.size === 0) return { precision: 0, recall: 0 };

    const hits = [...used].filter((capability) => expectedSet.has(capability)).length;

    return {
      precision: hits / used.size,
      recall: expectedSet.size === 0 ? 0 : hits / expectedSet.size,
    };
  });

  const precision = mean(perRun.map((r) => r.precision));
  const recall = mean(perRun.map((r) => r.recall));
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

export function scoreScenario(
  scenario: Scenario,
  observations: readonly RunObservation[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ScenarioMetrics {
  const runs = observations.length;

  const completionRate = rate(observations.filter((o) => o.ok).length, runs);
  const planValidityRate = rate(observations.filter((o) => o.planAttempts === 1).length, runs);
  const withinMaxStepsRate = rate(
    observations.filter((o) => o.taskCount <= scenario.maxSteps).length,
    runs,
  );

  const terminalCorrectRate =
    scenario.terminalCapability === undefined
      ? 1
      : rate(
          observations.filter((o) => o.capabilities.at(-1) === scenario.terminalCapability)
            .length,
          runs,
        );

  const { precision, recall, f1 } = capabilityScores(
    observations,
    scenario.expectedCapabilities,
  );

  const meanTasks = mean(observations.map((o) => o.taskCount));
  // Capped at 1: a plan with fewer steps than "optimal" is not more than
  // perfect, it is probably missing work — and completionRate will say so.
  const stepEfficiency = meanTasks === 0 ? 0 : Math.min(1, scenario.optimalSteps / meanTasks);

  const signatures = [...new Set(observations.map(signatureOf))];

  const failures: string[] = [];
  if (completionRate < thresholds.completionRate) {
    failures.push(`completion ${(completionRate * 100).toFixed(0)}%`);
  }
  if (recall < thresholds.capabilityRecall) {
    failures.push(`capability recall ${(recall * 100).toFixed(0)}%`);
  }
  if (precision < thresholds.capabilityPrecision) {
    failures.push(`capability precision ${(precision * 100).toFixed(0)}% (unnecessary work)`);
  }
  if (planValidityRate < thresholds.planValidityRate) {
    failures.push(`plan validity ${(planValidityRate * 100).toFixed(0)}%`);
  }
  if (withinMaxStepsRate < 1) {
    failures.push(`exceeded maxSteps ${scenario.maxSteps}`);
  }
  if (terminalCorrectRate < 1 && scenario.terminalCapability !== undefined) {
    failures.push(`did not end on ${scenario.terminalCapability}`);
  }

  return {
    runs,
    completionRate,
    planValidityRate,
    capabilityPrecision: precision,
    capabilityRecall: recall,
    capabilityF1: f1,
    terminalCorrectRate,
    stepEfficiency,
    withinMaxStepsRate,
    replanRate: rate(observations.filter((o) => o.replans > 0).length, runs),
    meanTokensIn: mean(observations.map((o) => o.tokensIn)),
    meanTokensOut: mean(observations.map((o) => o.tokensOut)),
    meanDurationMs: mean(observations.map((o) => o.durationMs)),
    signatures,
    stable: signatures.length <= 1,
    pass: failures.length === 0,
    failures,
  };
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScenarioResult {
  scenario: Scenario;
  observations: RunObservation[];
  metrics: ScenarioMetrics;
}

export interface SuiteSummary {
  scenarios: number;
  runsPerScenario: number;
  passed: number;
  failed: number;
  passRate: number;
  /** Scenarios whose repeats did not decompose the goal identically. */
  unstable: string[];
  completionRate: number;
  planValidityRate: number;
  capabilityF1: number;
  stepEfficiency: number;
  totalTokensIn: number;
  totalTokensOut: number;
  /**
   * True when the run could not observe variance at all, because responses
   * were replayed from fixtures. Reporting "0 unstable" without this would
   * claim a stability the run never tested for.
   */
  varianceMeasurable: boolean;
}

export function summarise(
  results: readonly ScenarioResult[],
  options: { varianceMeasurable: boolean },
): SuiteSummary {
  const passed = results.filter((r) => r.metrics.pass).length;

  return {
    scenarios: results.length,
    runsPerScenario: results[0]?.metrics.runs ?? 0,
    passed,
    failed: results.length - passed,
    passRate: rate(passed, results.length),
    unstable: results.filter((r) => !r.metrics.stable).map((r) => r.scenario.id),
    completionRate: mean(results.map((r) => r.metrics.completionRate)),
    planValidityRate: mean(results.map((r) => r.metrics.planValidityRate)),
    capabilityF1: mean(results.map((r) => r.metrics.capabilityF1)),
    stepEfficiency: mean(results.map((r) => r.metrics.stepEfficiency)),
    totalTokensIn: results.reduce(
      (sum, r) => sum + r.observations.reduce((s, o) => s + o.tokensIn, 0),
      0,
    ),
    totalTokensOut: results.reduce(
      (sum, r) => sum + r.observations.reduce((s, o) => s + o.tokensOut, 0),
      0,
    ),
    varianceMeasurable: options.varianceMeasurable,
  };
}
