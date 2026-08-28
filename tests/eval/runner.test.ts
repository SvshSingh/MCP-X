import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MIN_PASS_RATE, loadScenarios, runEval, SCENARIO_DIR } from "../../eval/runner.js";

let dir: string;
let scenarioDir: string;
let fixtureDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpx-eval-"));
  // Scenarios and fixtures both end in .json; a shared directory would let a
  // fixture write silently clobber a scenario of the same id.
  scenarioDir = join(dir, "scenarios");
  fixtureDir = join(dir, "fixtures");
  mkdirSync(scenarioDir);
  mkdirSync(fixtureDir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a single scenario + a fixture that always answers it identically. */
function writeFixtureScenario(
  scenarioDir: string,
  fixtureDir: string,
  options: {
    id: string;
    goal: string;
    expectedCapabilities: string[];
    tasks: { id: string; description: string; dependsOn?: string[] }[];
    optimalSteps?: number;
    maxSteps?: number;
  },
): void {
  writeFileSync(
    join(scenarioDir, `${options.id}.json`),
    JSON.stringify({
      id: options.id,
      goal: options.goal,
      expectedCapabilities: options.expectedCapabilities,
      optimalSteps: options.optimalSteps ?? options.tasks.length,
      maxSteps: options.maxSteps ?? options.tasks.length + 2,
    }),
    "utf8",
  );

  writeFileSync(
    join(fixtureDir, `${options.id}.json`),
    JSON.stringify({
      goal: options.goal,
      response: JSON.stringify({ tasks: options.tasks }),
      tokensIn: 10,
      tokensOut: 5,
    }),
    "utf8",
  );
}

/* -------------------------------------------------------------------------- */

describe("runEval — against the repo's real golden set", () => {
  it("loads the full 15-scenario suite from the repo", () => {
    // Sanity check on the fixture directory itself, independent of scoring.
    expect(loadScenarios(SCENARIO_DIR).length).toBe(15);
  });

  it("runs fixture mode with no network and produces a scored suite", async () => {
    const { results, summary } = await runEval({
      repeats: 1,
      reportPath: join(dir, "report.md"),
    });

    expect(results).toHaveLength(15);
    expect(summary.scenarios).toBe(15);
    expect(summary.passed + summary.failed).toBe(15);
  });

  it("gates on the pass rate meeting the floor, not on every scenario passing", async () => {
    // Today's honest baseline is 14/15 (documented: one scenario fails on the
    // keyword classifier's tie ceiling). The default floor is pinned to
    // exactly that, so this suite must pass today without every scenario
    // passing individually.
    const { summary, passed, minPassRate } = await runEval({
      repeats: 1,
      reportPath: join(dir, "report.md"),
    });

    expect(minPassRate).toBe(DEFAULT_MIN_PASS_RATE);
    expect(summary.failed).toBeGreaterThan(0);
    expect(passed).toBe(true);
  });

  it("would fail if the floor demanded every scenario pass", async () => {
    // Proves the gate is real: raising the floor to 100% against the same
    // suite flips the result, so passed:true above is not a tautology.
    const { passed } = await runEval({
      repeats: 1,
      minPassRate: 1,
      reportPath: join(dir, "report.md"),
    });

    expect(passed).toBe(false);
  });

  it("writes the report to the requested path", async () => {
    const reportPath = join(dir, "custom-report.md");

    await runEval({ repeats: 1, reportPath });

    // If the write failed, reading it back would throw; that's assertion enough.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(reportPath, "utf8")).toContain("MCP-X evaluation report");
  });
});

/* -------------------------------------------------------------------------- */

describe("runEval — the gate catches a real regression", () => {
  it("passes a suite that behaves correctly", async () => {
    writeFixtureScenario(scenarioDir, fixtureDir, {
      id: "healthy",
      goal: "do the healthy thing",
      expectedCapabilities: ["compute"],
      tasks: [{ id: "a", description: "Calculate the result.", dependsOn: [] }],
    });

    const { passed, summary } = await runEval({
      repeats: 1,
      scenarioDir,
      fixtureDir,
      reportPath: join(dir, "report.md"),
    });

    expect(summary.passRate).toBe(1);
    expect(passed).toBe(true);
  });

  it("fails a suite that regresses below the floor", async () => {
    // Two scenarios, one of which produces a plan with no capability the
    // scenario expects at all -- a genuine regression, not an edge case.
    writeFixtureScenario(scenarioDir, fixtureDir, {
      id: "healthy",
      goal: "do the healthy thing",
      expectedCapabilities: ["compute"],
      tasks: [{ id: "a", description: "Calculate the result.", dependsOn: [] }],
    });
    writeFixtureScenario(scenarioDir, fixtureDir, {
      id: "regressed",
      goal: "do the regressed thing",
      expectedCapabilities: ["publish"],
      tasks: [{ id: "b", description: "Calculate the result.", dependsOn: [] }],
    });

    const { passed, summary } = await runEval({
      repeats: 1,
      scenarioDir,
      fixtureDir,
      reportPath: join(dir, "report.md"),
    });

    // 1 of 2 = 50%, below the default 80% floor.
    expect(summary.passRate).toBe(0.5);
    expect(passed).toBe(false);
  });

  it("respects a custom floor", async () => {
    writeFixtureScenario(scenarioDir, fixtureDir, {
      id: "healthy",
      goal: "do the healthy thing",
      expectedCapabilities: ["compute"],
      tasks: [{ id: "a", description: "Calculate the result.", dependsOn: [] }],
    });
    writeFixtureScenario(scenarioDir, fixtureDir, {
      id: "regressed",
      goal: "do the regressed thing",
      expectedCapabilities: ["publish"],
      tasks: [{ id: "b", description: "Calculate the result.", dependsOn: [] }],
    });

    const lenient = await runEval({
      repeats: 1,
      scenarioDir,
      fixtureDir,
      minPassRate: 0.4,
      reportPath: join(dir, "report.md"),
    });
    const strict = await runEval({
      repeats: 1,
      scenarioDir,
      fixtureDir,
      minPassRate: 0.9,
      reportPath: join(dir, "report.md"),
    });

    expect(lenient.passed).toBe(true);
    expect(strict.passed).toBe(false);
  });
});

describe("runEval — scenario selection and errors", () => {
  it("throws a listing error when `only` matches nothing", async () => {
    await expect(
      runEval({ repeats: 1, only: ["does-not-exist"], reportPath: join(dir, "report.md") }),
    ).rejects.toThrow(/No scenarios matched/);
  });

  it("restricts the suite to the requested ids", async () => {
    const { results } = await runEval({
      repeats: 1,
      only: ["add-two-numbers", "backlog-triage"],
      reportPath: join(dir, "report.md"),
    });

    expect(results.map((r) => r.scenario.id).sort()).toEqual(["add-two-numbers", "backlog-triage"]);
  });
});
