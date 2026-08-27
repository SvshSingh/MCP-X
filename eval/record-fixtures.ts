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
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPlan } from "../src/kernel/planner.js";
import { createLlmClient } from "../src/llm/index.js";
import { EVAL_FIXTURE_DIR, loadScenarios } from "./runner.js";

const force = process.argv.includes("--force");

async function main(): Promise<number> {
  const scenarios = loadScenarios();
  const llm = createLlmClient({ mode: "gemini" });

  mkdirSync(EVAL_FIXTURE_DIR, { recursive: true });
  console.log(`Recording against ${llm.name} (${scenarios.length} scenarios)\n`);

  let recorded = 0;
  let skipped = 0;

  for (const scenario of scenarios) {
    const path = join(EVAL_FIXTURE_DIR, `${scenario.id}.json`);

    if (existsSync(path) && !force) {
      console.log(`  skip     ${scenario.id}`);
      skipped++;
      continue;
    }

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
      console.error(
        `  FAILED   ${scenario.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }

  console.log(`\nRecorded ${recorded}, skipped ${skipped}.`);
  return 0;
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
