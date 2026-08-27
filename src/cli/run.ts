/**
 * Plan a goal, then execute it.
 *
 *   npm run execute -- "post a summary of today's top HN story to Twitter"
 *   PLANNER_MODE=fixture npm run execute -- "restock the warehouse for next week"
 *   PLANNER_MODE=fixture FAIL_TASK=fetch_story_content npm run execute -- "<goal>"
 *
 * Agents are stubbed: Phase 4 replaces the stub with real specialists routed
 * over MCP. What this demonstrates is the orchestration itself -- wave-by-wave
 * parallel dispatch, retry, and the blast radius of a failure.
 *
 * `FAIL_TASK` forces a task to fail so the blocked-subtree policy is visible
 * without breaking a real tool.
 */

import { buildSpecialists, defaultRegistry } from "../agents/registry.js";
import { createLlmClient } from "../llm/index.js";
import { LlmError, type LlmClient } from "../llm/types.js";
import { classifyTask } from "../kernel/classifier.js";
import { createPlan, PlannerError } from "../kernel/planner.js";
import { blockedByFailures, runPlan, type AgentRunner } from "../kernel/orchestrator.js";
import { executionWaves } from "../kernel/scheduler.js";
import type { Plan } from "../kernel/schemas.js";

const STATUS_MARK: Record<string, string> = {
  completed: "OK  ",
  failed: "FAIL",
  blocked: "BLOK",
  pending: "....",
  running: "RUN ",
};

/**
 * Simulated work, dispatched through the real specialist wrappers.
 *
 * Tool selection is still stubbed — what is real here is the ownership
 * boundary: a task routed to `compute` is handed a specialist that physically
 * cannot reach `createPost`.
 */
function specialistRunner(failTask: string | undefined): AgentRunner {
  const specialists = buildSpecialists();

  return async (task, ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 40));

    if (task.id === failTask) {
      return { taskId: task.id, ok: false, error: `simulated failure in ${task.id}` };
    }

    const specialist = specialists.get(ctx.agent);
    const tools = specialist?.toolNames ?? [];

    return {
      taskId: task.id,
      ok: true,
      output: `[${ctx.agent}${tools.length > 0 ? ` -> ${tools.join(",")}` : ""}] ${task.description}`,
      tokensIn: 40,
      tokensOut: 25,
    };
  };
}

function printWaves(plan: Plan): void {
  const waves = executionWaves(plan);
  console.log(`Plan: ${plan.tasks.length} tasks in ${waves.length} wave(s)`);

  waves.forEach((wave, index) => {
    const parallel = wave.length > 1 ? `  <- ${wave.length} in parallel` : "";
    console.log(`  wave ${index + 1}: ${wave.map((t) => t.id).join(", ")}${parallel}`);
  });
}

async function main(): Promise<number> {
  const goal = process.argv.slice(2).join(" ").trim();
  if (goal === "") {
    console.error('Usage: npm run execute -- "<goal>"');
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

  let plan: Plan;
  try {
    plan = (await createPlan(goal, { llm })).plan;
  } catch (error) {
    console.error(error instanceof PlannerError ? error.message : String(error));
    return 1;
  }

  printWaves(plan);
  console.log();

  const failTask = process.env["FAIL_TASK"];
  if (failTask !== undefined) console.log(`Forcing failure in: ${failTask}\n`);

  // Routing uses the model when one is available, and falls back to
  // deterministic keyword scoring otherwise. `ROUTE=keyword` forces the
  // deterministic path even when a key is present.
  const registry = defaultRegistry();
  const routeWith: LlmClient | undefined =
    process.env["ROUTE"] === "keyword" || llm.name === "fixture" ? undefined : llm;

  const started = Date.now();
  const outcome = await runPlan({
    plan,
    execute: specialistRunner(failTask),
    classify: async (task) => {
      const decision = await classifyTask(task, { registry, ...(routeWith ? { llm: routeWith } : {}), useHint: false });
      return decision.agent;
    },
    onEvent: (event) => {
      const e = event as { type: string; taskId?: string; agent?: string; attempt?: number };
      if (e.type === "task_started") {
        console.log(`  -> ${e.taskId} [${e.agent}] attempt ${e.attempt}`);
      }
    },
  });
  const elapsed = Date.now() - started;

  console.log();
  console.log("Result:");
  for (const task of plan.tasks) {
    const state = outcome.state.tasks.get(task.id);
    const mark = STATUS_MARK[state?.status ?? "pending"] ?? "????";
    const reason = state?.error === undefined ? "" : `  (${state.error})`;
    console.log(`  ${mark}  ${task.id}${reason}`);
  }

  const blocked = blockedByFailures(plan, outcome.state);
  if (blocked.size > 0) {
    console.log();
    for (const [failedId, downstream] of blocked) {
      console.log(
        `  "${failedId}" failed, blocking ${downstream.length}: ${downstream.join(", ")}`,
      );
    }
  }

  console.log();
  console.log(
    `Run ${outcome.record.runId}: ${outcome.ok ? "succeeded" : "failed"} in ${elapsed}ms, ` +
      `${outcome.record.events.length} events, ` +
      `${outcome.record.totalTokens.in} in / ${outcome.record.totalTokens.out} out`,
  );

  return outcome.ok ? 0 : 1;
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
