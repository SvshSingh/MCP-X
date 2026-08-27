/**
 * Plan a goal from the command line.
 *
 *   npm run plan -- "post a summary of today's top HN story to Twitter"
 *   PLANNER_MODE=fixture npm run plan -- "add 2 and 3 and tell me the answer"
 *
 * Prints the DAG as an indented tree so the dependency structure is readable
 * without opening the JSON. Phase 3 replaces this with an actual execution.
 */

import { createLlmClient } from "../llm/index.js";
import { LlmError } from "../llm/types.js";
import { createPlan, PlannerError } from "../kernel/planner.js";
import type { Plan, Task } from "../kernel/schemas.js";

function renderTree(plan: Plan): string[] {
  const lines: string[] = [];
  const emitted = new Set<string>();

  const emit = (task: Task, depth: number): void => {
    const indent = "  ".repeat(depth);
    const hint = task.agentHint === undefined ? "" : ` [${task.agentHint}]`;
    const repeated = emitted.has(task.id) ? " (see above)" : "";
    lines.push(`${indent}- ${task.id}${hint}: ${task.description}${repeated}`);

    if (repeated) return;
    emitted.add(task.id);

    for (const dependent of plan.tasks) {
      if (dependent.dependsOn.includes(task.id)) emit(dependent, depth + 1);
    }
  };

  for (const task of plan.tasks) {
    if (task.dependsOn.length === 0) emit(task, 0);
  }

  // Anything unreachable from a root would be part of a cycle, which Plan
  // already rejects - but print it rather than silently dropping it.
  for (const task of plan.tasks) {
    if (!emitted.has(task.id)) lines.push(`- ${task.id} (unreachable): ${task.description}`);
  }

  return lines;
}

async function main(): Promise<number> {
  const goal = process.argv.slice(2).join(" ").trim();

  if (goal === "") {
    console.error('Usage: npm run plan -- "<goal>"');
    return 2;
  }

  let llm;
  try {
    llm = createLlmClient();
  } catch (error) {
    console.error(error instanceof LlmError ? error.message : String(error));
    return 1;
  }

  console.log(`Goal:    ${goal}`);
  console.log(`Planner: ${llm.name}`);
  console.log();

  try {
    const result = await createPlan(goal, { llm });

    for (const attempt of result.attempts) {
      if (attempt.errors.length > 0) {
        console.log(`Attempt ${attempt.attempt} rejected:`);
        for (const error of attempt.errors) console.log(`  - ${error}`);
        console.log();
      }
    }

    console.log(`Plan (revision ${result.plan.revision}, ${result.plan.tasks.length} tasks):`);
    for (const line of renderTree(result.plan)) console.log(line);

    console.log();
    console.log(
      `Attempts: ${result.attempts.length}  Tokens: ${result.tokensIn} in / ${result.tokensOut} out`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PlannerError) {
      console.error(error.message);
      console.error(
        `Gave up after ${error.attempts.length} attempt(s), ${error.tokensIn} in / ${error.tokensOut} out.`,
      );
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
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
