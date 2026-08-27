import { describe, expect, it } from "vitest";

import {
  Scenario,
  scoreScenario,
  summarise,
  type RunObservation,
  type ScenarioResult,
} from "../../eval/metrics.js";
import { renderReport, type ReportContext } from "../../eval/report.js";

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

const resultFor = (s: Scenario, observations: RunObservation[]): ScenarioResult => ({
  scenario: s,
  observations,
  metrics: scoreScenario(s, observations),
});

const context = (over: Partial<ReportContext> = {}): ReportContext => ({
  mode: "fixture",
  model: "fixture",
  runsPerScenario: 3,
  generatedAt: "2026-08-27T10:00:00.000Z",
  durationMs: 1234,
  ...over,
});

const render = (
  results: ScenarioResult[],
  opts: { varianceMeasurable: boolean },
  ctx: Partial<ReportContext> = {},
) => renderReport(results, summarise(results, opts), context(ctx));

/** Every table row must be pipe-delimited on both sides to render as a table. */
const tableRows = (markdown: string) =>
  markdown.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("|---"));

/* -------------------------------------------------------------------------- */

describe("renderReport", () => {
  const passing = resultFor(scenario(), [observation(), observation(), observation()]);

  it("states the headline pass count", () => {
    const markdown = render([passing], { varianceMeasurable: true });

    expect(markdown).toContain("**1/1 scenarios passed.**");
  });

  it("names the failure count when something failed", () => {
    const failing = resultFor(scenario(), [observation({ ok: false })]);

    expect(render([failing], { varianceMeasurable: true })).toContain("1 failed");
  });

  it("closes every table row on both sides", () => {
    // A row missing its outer pipes silently stops rendering as a table.
    const markdown = render([passing], { varianceMeasurable: true });

    for (const row of tableRows(markdown)) {
      expect(row.endsWith(" |"), row).toBe(true);
    }
  });

  it("keeps the header and body column counts equal", () => {
    const markdown = render([passing], { varianceMeasurable: true });
    const lines = markdown.split("\n");
    const headerIndex = lines.findIndex((l) => l.startsWith("| Scenario |"));
    const columns = (line: string) => line.split("|").length;

    expect(headerIndex).toBeGreaterThan(-1);
    expect(columns(lines[headerIndex + 2] ?? "")).toBe(columns(lines[headerIndex] ?? ""));
  });

  it("says variance was not measured under fixture replay", () => {
    const markdown = render([passing], { varianceMeasurable: false });

    // Reporting "0 unstable" here would claim a stability never tested for.
    expect(markdown).toContain("Variance was not measured");
    expect(markdown).toContain("not measurable (fixture replay)");
    expect(markdown).not.toContain("stable |\n| `s1` | pass | 100% | 100% | 100% | 100% | 4.0");
  });

  it("reports stability when variance was measurable", () => {
    const markdown = render([passing], { varianceMeasurable: true }, { mode: "live" });

    expect(markdown).toContain("decomposed identically");
    expect(markdown).toContain("1/1 stable");
  });

  it("names unstable scenarios and lists their distinct shapes", () => {
    const unstable = resultFor(scenario({ id: "wobbly" }), [
      observation(),
      observation({ taskCount: 6, capabilities: ["research", "compute", "publish"] }),
    ]);

    const markdown = render([unstable], { varianceMeasurable: true }, { mode: "live" });

    expect(markdown).toContain("varied between runs");
    expect(markdown).toContain("`wobbly`");
    expect(markdown).toContain("Cross-run variance");
    expect(markdown).toContain("2 distinct shapes");
  });

  it("omits the variance section entirely under fixture replay", () => {
    const unstable = resultFor(scenario({ id: "wobbly" }), [
      observation(),
      observation({ taskCount: 6 }),
    ]);

    expect(render([unstable], { varianceMeasurable: false })).not.toContain(
      "## Cross-run variance",
    );
  });

  it("explains each failure with its reasons", () => {
    const failing = resultFor(scenario({ expectedCapabilities: ["compute"] }), [
      observation({ capabilities: ["research", "compute"] }),
    ]);

    const markdown = render([failing], { varianceMeasurable: true });

    expect(markdown).toContain("## Failures");
    expect(markdown).toContain("precision");
    expect(markdown).toContain("do the thing");
  });

  it("surfaces run errors in the failure section", () => {
    const failing = resultFor(scenario(), [
      observation({ ok: false, error: "planner gave up after 3 attempts" }),
    ]);

    expect(render([failing], { varianceMeasurable: true })).toContain(
      "planner gave up after 3 attempts",
    );
  });

  it("omits the failure section when everything passed", () => {
    expect(render([passing], { varianceMeasurable: true })).not.toContain("## Failures");
  });

  it("records mode, model and duration in the header", () => {
    const markdown = render([passing], { varianceMeasurable: true }, {
      mode: "live",
      model: "gemini-3.1-flash-lite",
      durationMs: 16700,
    });

    expect(markdown).toContain("mode `live`");
    expect(markdown).toContain("`gemini-3.1-flash-lite`");
    expect(markdown).toContain("16.7s");
  });

  it("renders an empty suite without crashing", () => {
    expect(() => render([], { varianceMeasurable: false })).not.toThrow();
  });

  it("ends with a trailing newline", () => {
    expect(render([passing], { varianceMeasurable: true }).endsWith("\n")).toBe(true);
  });
});
