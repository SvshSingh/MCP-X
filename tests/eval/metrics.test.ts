import { describe, expect, it } from "vitest";

import {
  capabilityScores,
  DEFAULT_THRESHOLDS,
  Scenario,
  scoreScenario,
  signatureOf,
  summarise,
  type RunObservation,
  type ScenarioResult,
} from "../../eval/metrics.js";

const scenario = (over: Partial<Scenario> = {}): Scenario =>
  Scenario.parse({
    id: "s1",
    goal: "do the thing",
    expectedCapabilities: ["research", "compute", "publish"],
    terminalCapability: "publish",
    optimalSteps: 4,
    maxSteps: 8,
    ...over,
  });

const observation = (over: Partial<RunObservation> = {}): RunObservation => ({
  ok: true,
  planAttempts: 1,
  taskCount: 4,
  waveCount: 3,
  capabilities: ["research", "research", "compute", "publish"],
  replans: 0,
  tokensIn: 100,
  tokensOut: 50,
  durationMs: 1000,
  ...over,
});

const result = (over: Partial<ScenarioResult> = {}): ScenarioResult => {
  const s = over.scenario ?? scenario();
  const observations = over.observations ?? [observation()];
  return { scenario: s, observations, metrics: scoreScenario(s, observations), ...over };
};

/* -------------------------------------------------------------------------- */

describe("signatureOf", () => {
  it("excludes task ids", () => {
    // Three live runs of the same goal produced identical structure with
    // different ids every time. Keying on ids would report noise as variance.
    const signature = signatureOf(observation());

    expect(signature).not.toContain("fetch");
    expect(signature).toContain("n=4");
    expect(signature).toContain("caps=research>research>compute>publish");
  });

  it("is identical for runs that decomposed the goal the same way", () => {
    expect(signatureOf(observation())).toBe(signatureOf(observation()));
  });

  it("differs when the task count differs", () => {
    expect(signatureOf(observation({ taskCount: 5 }))).not.toBe(signatureOf(observation()));
  });

  it("differs when the capability sequence differs", () => {
    const other = observation({ capabilities: ["research", "compute", "compute", "publish"] });

    expect(signatureOf(other)).not.toBe(signatureOf(observation()));
  });

  it("differs when parallelism differs at equal task count", () => {
    expect(signatureOf(observation({ waveCount: 1 }))).not.toBe(signatureOf(observation()));
  });
});

describe("capabilityScores", () => {
  it("scores a perfectly targeted plan at 1", () => {
    const scores = capabilityScores([observation()], ["research", "compute", "publish"]);

    expect(scores.precision).toBe(1);
    expect(scores.recall).toBe(1);
  });

  it("scores on sets, so repetition is not rewarded", () => {
    // Four research tasks is one capability used, not four correct choices.
    const repeated = observation({
      capabilities: ["research", "research", "research", "research"],
    });

    expect(capabilityScores([repeated], ["research"]).precision).toBe(1);
  });

  it("penalises a capability the goal did not call for", () => {
    const padded = observation({ capabilities: ["research", "compute"] });

    // Only compute was wanted; research is unnecessary work.
    expect(capabilityScores([padded], ["compute"]).precision).toBe(0.5);
  });

  it("penalises a missing capability through recall", () => {
    const missing = observation({ capabilities: ["research", "compute"] });

    expect(capabilityScores([missing], ["research", "compute", "publish"]).recall).toBeCloseTo(
      2 / 3,
    );
  });

  it("returns zeros for a run that produced nothing", () => {
    const empty = observation({ capabilities: [] });

    expect(capabilityScores([empty], ["compute"])).toMatchObject({ precision: 0, recall: 0 });
  });
});

/* -------------------------------------------------------------------------- */

describe("scoreScenario", () => {
  it("passes a correct, well-targeted run", () => {
    const metrics = scoreScenario(scenario(), [observation()]);

    expect(metrics.pass).toBe(true);
    expect(metrics.failures).toEqual([]);
  });

  it("fails a run that did not complete", () => {
    const metrics = scoreScenario(scenario(), [observation({ ok: false })]);

    expect(metrics.pass).toBe(false);
    expect(metrics.failures.join(" ")).toContain("completion");
  });

  it("fails a plan that skipped a required capability", () => {
    const metrics = scoreScenario(scenario(), [
      observation({ capabilities: ["research", "compute"] }),
    ]);

    expect(metrics.pass).toBe(false);
    expect(metrics.failures.join(" ")).toContain("recall");
  });

  it("fails a padded plan on precision, even at full recall", () => {
    // The real finding this gate exists for: "add 2 and 3" routed through
    // research scores full recall while doing work nobody asked for.
    const metrics = scoreScenario(scenario({ expectedCapabilities: ["compute"] }), [
      observation({ capabilities: ["research", "compute", "compute"], taskCount: 3 }),
    ]);

    expect(metrics.capabilityRecall).toBe(1);
    expect(metrics.pass).toBe(false);
    expect(metrics.failures.join(" ")).toContain("precision");
  });

  it("fails a plan longer than maxSteps", () => {
    const metrics = scoreScenario(scenario({ maxSteps: 3 }), [observation({ taskCount: 4 })]);

    expect(metrics.pass).toBe(false);
    expect(metrics.failures.join(" ")).toContain("maxSteps");
  });

  it("fails a plan that does not end on the required capability", () => {
    const metrics = scoreScenario(scenario(), [
      observation({ capabilities: ["research", "compute", "publish", "compute"] }),
    ]);

    expect(metrics.pass).toBe(false);
    expect(metrics.failures.join(" ")).toContain("did not end on publish");
  });

  it("ignores terminal capability when the scenario declares none", () => {
    const noTerminal = Scenario.parse({
      id: "s2",
      goal: "g",
      expectedCapabilities: ["research", "compute", "publish"],
      optimalSteps: 4,
      maxSteps: 8,
    });

    expect(scoreScenario(noTerminal, [observation()]).terminalCorrectRate).toBe(1);
  });

  it("computes step efficiency against the optimal count", () => {
    const metrics = scoreScenario(scenario({ optimalSteps: 2 }), [observation({ taskCount: 4 })]);

    expect(metrics.stepEfficiency).toBe(0.5);
  });

  it("caps step efficiency at 1 rather than rewarding a too-short plan", () => {
    const metrics = scoreScenario(scenario({ optimalSteps: 4 }), [observation({ taskCount: 2 })]);

    // Fewer steps than optimal is not better than perfect; it usually means
    // missing work, which completionRate is the metric for.
    expect(metrics.stepEfficiency).toBe(1);
  });

  it("reports plan validity from first-attempt success", () => {
    const metrics = scoreScenario(scenario(), [
      observation({ planAttempts: 1 }),
      observation({ planAttempts: 2 }),
      observation({ planAttempts: 1 }),
    ]);

    expect(metrics.planValidityRate).toBeCloseTo(2 / 3);
  });

  it("marks repeats stable when every run decomposed identically", () => {
    const metrics = scoreScenario(scenario(), [observation(), observation(), observation()]);

    expect(metrics.stable).toBe(true);
    expect(metrics.signatures).toHaveLength(1);
  });

  it("marks repeats unstable and records every distinct shape", () => {
    const metrics = scoreScenario(scenario(), [
      observation(),
      observation({ taskCount: 5, capabilities: ["research", "compute", "compute", "publish"] }),
      observation(),
    ]);

    expect(metrics.stable).toBe(false);
    expect(metrics.signatures).toHaveLength(2);
  });

  it("reports the replan rate", () => {
    const metrics = scoreScenario(scenario(), [
      observation({ replans: 1 }),
      observation({ replans: 0 }),
    ]);

    expect(metrics.replanRate).toBe(0.5);
  });

  it("respects custom thresholds", () => {
    const lenient = { ...DEFAULT_THRESHOLDS, completionRate: 0.5 };
    const metrics = scoreScenario(
      scenario(),
      [observation(), observation({ ok: false })],
      lenient,
    );

    expect(metrics.completionRate).toBe(0.5);
    expect(metrics.failures.join(" ")).not.toContain("completion");
  });
});

/* -------------------------------------------------------------------------- */

describe("summarise", () => {
  it("counts passes and failures", () => {
    const good = result();
    const bad = result({ observations: [observation({ ok: false })] });

    const summary = summarise([good, bad], { varianceMeasurable: true });

    expect(summary.scenarios).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.passRate).toBe(0.5);
  });

  it("lists unstable scenarios by id", () => {
    const unstable = result({
      scenario: scenario({ id: "wobbly" }),
      observations: [observation(), observation({ taskCount: 9 })],
    });

    const summary = summarise([unstable], { varianceMeasurable: true });

    expect(summary.unstable).toEqual(["wobbly"]);
  });

  it("carries whether variance could be observed at all", () => {
    // Reporting "0 unstable" from a fixture replay would claim a stability the
    // run never tested for.
    expect(summarise([result()], { varianceMeasurable: false }).varianceMeasurable).toBe(false);
  });

  it("totals tokens across every run of every scenario", () => {
    const summary = summarise([result({ observations: [observation(), observation()] })], {
      varianceMeasurable: true,
    });

    expect(summary.totalTokensIn).toBe(200);
    expect(summary.totalTokensOut).toBe(100);
  });

  it("handles an empty suite without dividing by zero", () => {
    const summary = summarise([], { varianceMeasurable: true });

    expect(summary.passRate).toBe(0);
    expect(summary.scenarios).toBe(0);
  });
});
