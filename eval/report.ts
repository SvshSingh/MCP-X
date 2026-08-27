/**
 * Renders the evaluation results as Markdown.
 *
 * Kept separate from the runner so the formatting is testable without
 * executing anything.
 */

import type { ScenarioResult, SuiteSummary } from "./metrics.js";

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const num = (value: number): string => value.toFixed(2);

export interface ReportContext {
  mode: "fixture" | "live";
  model: string;
  runsPerScenario: number;
  generatedAt: string;
  durationMs: number;
}

export function renderReport(
  results: readonly ScenarioResult[],
  summary: SuiteSummary,
  context: ReportContext,
): string {
  const lines: string[] = [];

  lines.push("# MCP-X evaluation report");
  lines.push("");
  lines.push(
    `Generated ${context.generatedAt} · mode \`${context.mode}\` · planner \`${context.model}\` · ` +
      `${summary.scenarios} scenarios × ${context.runsPerScenario} runs · ` +
      `${(context.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");

  lines.push(
    summary.failed === 0
      ? `**${summary.passed}/${summary.scenarios} scenarios passed.**`
      : `**${summary.passed}/${summary.scenarios} scenarios passed — ${summary.failed} failed.**`,
  );
  lines.push("");

  /* --- honesty note about variance ------------------------------------- */

  if (!summary.varianceMeasurable) {
    lines.push("> **Variance was not measured in this run.**");
    lines.push(">");
    lines.push(
      "> Planner responses were replayed from recorded fixtures, so every repeat is identical",
    );
    lines.push(
      "> by construction. A stability figure from this mode would be an artefact of the replay,",
    );
    lines.push(
      "> not a property of the model. Run `npm run eval:live` to measure real cross-run variance.",
    );
    lines.push("");
  } else if (summary.unstable.length === 0) {
    lines.push(
      `> Every scenario decomposed identically across all ${context.runsPerScenario} repeats.`,
    );
    lines.push("");
  } else {
    lines.push(
      `> **${summary.unstable.length} scenario(s) varied between runs:** ${summary.unstable
        .map((id) => `\`${id}\``)
        .join(", ")}`,
    );
    lines.push("");
  }

  /* --- suite totals ------------------------------------------------------ */

  lines.push("## Suite totals");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Scenario pass rate | ${pct(summary.passRate)} |`);
  lines.push(`| Task completion rate | ${pct(summary.completionRate)} |`);
  lines.push(`| Plan validity (valid DAG first try) | ${pct(summary.planValidityRate)} |`);
  lines.push(`| Capability F1 | ${num(summary.capabilityF1)} |`);
  lines.push(`| Step efficiency | ${num(summary.stepEfficiency)} |`);
  lines.push(
    `| Cross-run stability | ${
      summary.varianceMeasurable
        ? `${summary.scenarios - summary.unstable.length}/${summary.scenarios} stable`
        : "not measurable (fixture replay)"
    } |`,
  );
  lines.push(`| Tokens | ${summary.totalTokensIn} in / ${summary.totalTokensOut} out |`);
  lines.push("");

  /* --- per scenario ------------------------------------------------------ */

  lines.push("## Per scenario");
  lines.push("");
  lines.push(
    "| Scenario | Result | Complete | Valid DAG | Recall | Precision | Steps | Efficiency | Stable |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");

  for (const { scenario, metrics, observations } of results) {
    const meanSteps =
      observations.length === 0
        ? 0
        : observations.reduce((sum, o) => sum + o.taskCount, 0) / observations.length;

    const cells = [
      `\`${scenario.id}\``,
      metrics.pass ? "pass" : "**FAIL**",
      pct(metrics.completionRate),
      pct(metrics.planValidityRate),
      pct(metrics.capabilityRecall),
      pct(metrics.capabilityPrecision),
      `${meanSteps.toFixed(1)} / ${scenario.maxSteps}`,
      num(metrics.stepEfficiency),
      summary.varianceMeasurable ? (metrics.stable ? "yes" : "**no**") : "n/a",
    ];

    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  /* --- failures ---------------------------------------------------------- */

  const failing = results.filter((r) => !r.metrics.pass);
  if (failing.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const { scenario, metrics, observations } of failing) {
      lines.push(`### \`${scenario.id}\``);
      lines.push("");
      lines.push(`Goal: ${scenario.goal}`);
      lines.push("");
      for (const reason of metrics.failures) lines.push(`- ${reason}`);

      const errors = [...new Set(observations.flatMap((o) => (o.error ? [o.error] : [])))];
      for (const error of errors) lines.push(`- error: ${error}`);
      lines.push("");
    }
  }

  /* --- instability detail ------------------------------------------------ */

  const unstable = results.filter((r) => !r.metrics.stable);
  if (summary.varianceMeasurable && unstable.length > 0) {
    lines.push("## Cross-run variance");
    lines.push("");
    lines.push(
      "Distinct decompositions observed for the same goal. Task ids are excluded from the",
    );
    lines.push(
      "signature deliberately — the planner renames steps between runs while keeping the same",
    );
    lines.push("structure, and treating that as instability would report noise.");
    lines.push("");

    for (const { scenario, metrics } of unstable) {
      lines.push(`### \`${scenario.id}\` — ${metrics.signatures.length} distinct shapes`);
      lines.push("");
      for (const signature of metrics.signatures) lines.push(`- \`${signature}\``);
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}
