/** Entry point for `npm run eval` and `npm run eval:live`. */

import { runEval, DEFAULT_REPEATS, REPORT_PATH } from "./runner.js";

const live = process.argv.includes("--live") || process.env["EVAL_MODE"] === "live";
const repeatsArg = process.env["EVAL_REPEATS"];
const repeats = repeatsArg === undefined ? DEFAULT_REPEATS : Number(repeatsArg);
const onlyRaw = process.env["EVAL_ONLY"];
const only = onlyRaw === undefined ? undefined : onlyRaw.split(",").map((id) => id.trim());
const llmRouting = process.env["EVAL_ROUTING"] === "llm";

async function main(): Promise<number> {
  if (!Number.isInteger(repeats) || repeats < 1) {
    console.error(`EVAL_REPEATS must be a positive integer, got "${repeatsArg}"`);
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

  const { results, passed } = await runEval({
    repeats,
    live,
    llmRouting,
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

  const failed = results.filter((r) => !r.metrics.pass).length;
  console.log();
  console.log(
    `${results.length - failed}/${results.length} scenarios passed. Report written to ${REPORT_PATH}`,
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
