/**
 * Records real planner output for every scenario as a replay fixture.
 *
 *   npx tsx eval/record-fixtures.ts            # only missing ones
 *   npx tsx eval/record-fixtures.ts --force    # re-record everything
 *
 * The fixtures are *recorded model behaviour*, not hand-written JSON. That
 * distinction matters: a golden set I invented would test the harness against
 * my idea of what the planner does, which is exactly the thing the harness is
 * supposed to find out.
 *
 * Re-run this when the model or the planner prompt changes. It costs one live
 * API call per scenario.
 *
 * Paced deliberately: the free tier caps generateContent at 5 requests per
 * *minute*, separate from and stricter than the 20-per-day cap. Firing 15
 * scenarios back to back hits that ceiling around scenario 6 -- discovered by
 * this script doing exactly that. RECORD_DELAY_MS controls the gap; the
 * default clears 5/minute with room to spare.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPlan } from "../src/kernel/planner.js";
import { createLlmClient } from "../src/llm/index.js";
import { EVAL_FIXTURE_DIR, loadScenarios } from "./runner.js";

const force = process.argv.includes("--force");
const delayMs = Number(process.env["RECORD_DELAY_MS"] ?? 13_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const scenarios = loadScenarios();
  const llm = createLlmClient({ mode: "gemini" });

  mkdirSync(EVAL_FIXTURE_DIR, { recursive: true });
  console.log(
    `Recording against ${llm.name} (${scenarios.length} scenarios, ${delayMs}ms apart)\n`,
  );

  let recorded = 0;
  let skipped = 0;
  let failed = 0;
  let calledOnce = false;

  for (const scenario of scenarios) {
    const path = join(EVAL_FIXTURE_DIR, `${scenario.id}.json`);

    if (existsSync(path) && !force) {
      console.log(`  skip     ${scenario.id}`);
      skipped++;
      continue;
    }

    if (calledOnce) await sleep(delayMs);
    calledOnce = true;

    try {
      const result = await createPlan(scenario.goal, { llm });

      // Record the raw completion from the successful attempt, so replay
      // reproduces exactly what the model said, including its formatting.
      const raw = result.attempts.at(-1)?.raw ?? "";

      writeFileSync(
        path,
        `${JSON.stringify(
          {
            goal: scenario.goal,
            response: raw,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      console.log(
        `  recorded ${scenario.id.padEnd(24)} ${result.plan.tasks.length} tasks, ` +
          `${result.attempts.length} attempt(s)`,
      );
      recorded++;
    } catch (error) {
      // Keep going rather than abort: one scenario tripping the per-minute
      // limit should not discard fixtures already recorded this run, and the
      // failure list at the end says exactly what still needs a re-run.
      console.error(
        `  FAILED   ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      failed++;
    }
  }

  console.log(`\nRecorded ${recorded}, skipped ${skipped}, failed ${failed}.`);
  return failed > 0 ? 1 : 0;
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
