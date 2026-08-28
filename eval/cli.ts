/** Entry point for `npm run eval` and `npm run eval:live`. */

import { runEval, DEFAULT_MIN_PASS_RATE, DEFAULT_REPEATS, REPORT_PATH } from "./runner.js";

const live = process.argv.includes("--live") || process.env["EVAL_MODE"] === "live";
const repeatsArg = process.env["EVAL_REPEATS"];
const repeats = repeatsArg === undefined ? DEFAULT_REPEATS : Number(repeatsArg);
const onlyRaw = process.env["EVAL_ONLY"];
const only = onlyRaw === undefined ? undefined : onlyRaw.split(",").map((id) => id.trim());
const llmRouting = process.env["EVAL_ROUTING"] === "llm";
const minPassRateArg = process.env["EVAL_MIN_PASS_RATE"];
const minPassRate = minPassRateArg === undefined ? DEFAULT_MIN_PASS_RATE : Number(minPassRateArg);

async function main(): Promise<number> {
  if (!Number.isInteger(repeats) || repeats < 1) {
    console.error(`EVAL_REPEATS must be a positive integer, got "${repeatsArg}"`);
    return 2;
  }
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    console.error(`EVAL_MIN_PASS_RATE must be a number between 0 and 1, got "${minPassRateArg}"`);
    return 2;
  }

  console.log(
    `Running evaluation: mode=${live ? "live" : "fixture"} repeats=${repeats} ` +
      `routing=${llmRouting ? "llm" : "keyword"}${only === undefined ? "" : ` only=${only.join(",")}`}`,
  );
  if (!live) {
    console.log("Fixture replay - deterministic, so cross-run variance is not measurable here.");
  }
  console.log();

  const { results, summary, passed } = await runEval({
    repeats,
    live,
    llmRouting,
    minPassRate,
    ...(only === undefined ? {} : { only }),
    onProgress: (message) => {
      process.stdout.write(`  ${message}\r`);
    },
  });

  process.stdout.write(" ".repeat(60) + "\r");

  for (const { scenario, metrics } of results) {
    const mark = metrics.pass ? "pass" : "FAIL";
    const detail = metrics.pass ? "" : `  (${metrics.failures.join("; ")})`;
    console.log(`  ${mark.padEnd(5)} ${scenario.id}${detail}`);
  }

  console.log();
  console.log(`${summary.passed}/${summary.scenarios} scenarios passed. Report written to ${REPORT_PATH}`);
  // The gate is on the rate meeting a floor, not on every scenario passing --
  // this line makes that explicit rather than leaving pass/fail unexplained.
  console.log(
    `Gate: pass rate ${(summary.passRate * 100).toFixed(0)}% ${
      passed ? ">=" : "<"
    } ${(minPassRate * 100).toFixed(0)}% floor -> ${passed ? "OK" : "BUILD FAILS"}`,
  );

  return passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
