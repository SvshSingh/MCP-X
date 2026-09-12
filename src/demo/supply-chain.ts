/**
 * The end-to-end supply-chain run: plan a goal against the real tool catalog,
 * execute it with real tools, repair it if a supplier cannot be reached, and
 * persist everything.
 *
 * Kept free of console output. The CLI in `src/cli/demo.ts` narrates by
 * listening to `onEvent`, and the end-to-end test drives this exact function —
 * so the run shown on a screen share is the same code path CI verifies.
 *
 * Phase 9 of ORCHESTRATOR_PLAN.md.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultRegistry } from "../agents/registry.js";
import {
  makeSupplyChainTools,
  DEFAULT_OUTBOX_DIR,
  type ComplianceOutput,
  type InventoryOutput,
  type ManualReviewOutput,
  type NotificationOutput,
  type ReorderOutput,
} from "../domain/supply-chain/tools.js";
import { loadWarehouse, DEFAULT_WAREHOUSE_PATH, type Warehouse } from "../domain/supply-chain/warehouse.js";
import type { RunState } from "../kernel/blackboard.js";
import { runPlan } from "../kernel/orchestrator.js";
import { createPlan } from "../kernel/planner.js";
import { llmReplanner } from "../kernel/replanner.js";
import { executionWaves } from "../kernel/scheduler.js";
import type { Event, Plan, RunRecord, Task } from "../kernel/schemas.js";
import { catalogOf } from "../kernel/tool-catalog.js";
import { createToolRunner, toolOwnerClassifier } from "../kernel/tool-runner.js";
import type { LlmClient } from "../llm/types.js";
import { renderRunReport } from "../observability/html-report.js";
import { DEFAULT_RUN_DIR, RunLogWriter } from "../observability/runlog.js";

export const DEMO_GOAL =
  "Check warehouse stock levels, work out reorder quantities, make sure every order is compliant, and notify the suppliers";

/** Recorded model output the offline demo replays. Written by `npm run demo:record`. */
export const DEMO_FIXTURE_DIR = join("fixtures", "demo");

/** The supplier whose portal `--fail` takes down. Chosen because it holds approved lines. */
export const FAILING_SUPPLIER = "SUP-NOVA";

export type DemoEvent =
  | { type: "planned"; plan: Plan; attempts: number; waves: Task[][] }
  | { type: "task_started"; taskId: string; tool: string | undefined; agent: string; attempt: number }
  | { type: "tool_result"; taskId: string; tool: string; ok: boolean; text: string; durationMs: number }
  | { type: "task_failed"; taskId: string; error: string; willRetry: boolean }
  | { type: "replan"; fromRevision: number; toRevision: number; reason: string; plan: Plan }
  | { type: "replan_error"; message: string };

export interface DemoOptions {
  llm: LlmClient;
  goal?: string;
  /** Take a supplier's ordering portal down, so notification fails and the run must repair itself. */
  failPortal?: boolean;
  warehousePath?: string;
  outboxDir?: string;
  runDir?: string;
  runId?: string;
  now?: () => Date;
  onEvent?: (event: DemoEvent) => void;
}

export interface DemoResult {
  runId: string;
  ok: boolean;
  goal: string;
  model: string;
  warehouse: Warehouse;
  record: RunRecord;
  state: RunState;
  initialPlan: Plan;
  finalPlan: Plan;
  inventory?: InventoryOutput;
  reorder?: ReorderOutput;
  compliance?: ComplianceOutput;
  notification?: NotificationOutput;
  manualReview?: ManualReviewOutput;
  runLogPath: string;
  reportPath: string;
  outboxDir: string;
  elapsedMs: number;
}

/** The structured output of the first completed task that produced `kind`. */
function outputOfKind<T>(state: RunState, kind: string): T | undefined {
  for (const task of state.tasks.values()) {
    const data = task.result?.data as { kind?: unknown } | undefined;
    if (task.status === "completed" && data?.kind === kind) return data as T;
  }
  return undefined;
}

export async function runSupplyChainDemo(options: DemoOptions): Promise<DemoResult> {
  const goal = options.goal ?? DEMO_GOAL;
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? `run-${now().getTime().toString(36)}`;
  const runDir = options.runDir ?? DEFAULT_RUN_DIR;
  const outboxDir = options.outboxDir ?? DEFAULT_OUTBOX_DIR;
  const warehouse = loadWarehouse(options.warehousePath ?? DEFAULT_WAREHOUSE_PATH);

  const tools = makeSupplyChainTools({
    loadWarehouse: () => warehouse,
    outboxDir,
    now,
    portalDown: options.failPortal ? [FAILING_SUPPLIER] : [],
  });
  const catalog = catalogOf(tools);
  const registry = defaultRegistry();
  const emit = (event: DemoEvent) => options.onEvent?.(event);

  const started = Date.now();
  const writer = new RunLogWriter(runId, runDir);
  writer.write({
    kind: "header",
    runId,
    goal,
    startedAt: now().toISOString(),
    ...(options.llm.name === "fixture" ? {} : { model: options.llm.name }),
  });

  const planned = await createPlan(goal, { llm: options.llm, tools: catalog, now });
  emit({
    type: "planned",
    plan: planned.plan,
    attempts: planned.attempts.length,
    waves: executionWaves(planned.plan),
  });

  const runner = createToolRunner({
    registry,
    tools,
    onToolCall: ({ task, tool, ok, text, durationMs }) =>
      emit({ type: "tool_result", taskId: task.id, tool, ok, text, durationMs }),
  });

  let currentPlan = planned.plan;
  // The orchestrator appends the `replan` event before the new revision takes
  // effect, so the event alone cannot say what the new route is. Hold its
  // reason until the revision arrives, then announce both together.
  let pendingReplan: { fromRevision: number; toRevision: number; reason: string } | undefined;

  const outcome = await runPlan({
    plan: planned.plan,
    runId,
    now,
    priorUsage: { in: planned.tokensIn, out: planned.tokensOut },
    classify: toolOwnerClassifier(registry),
    execute: runner,
    replan: llmReplanner({ llm: options.llm, tools: catalog, now }),
    onPlanRevision: (revision) => {
      writer.write({ kind: "plan", plan: revision });
      if (revision.revision === 0) return;
      currentPlan = revision;
      if (pendingReplan) {
        emit({ type: "replan", ...pendingReplan, plan: revision });
        pendingReplan = undefined;
      }
    },
    onReplanError: (error) =>
      emit({ type: "replan_error", message: error instanceof Error ? error.message : String(error) }),
    onEvent: (raw) => {
      const event = raw as Event;
      writer.write({ kind: "event", event });

      if (event.type === "task_started") {
        const task = currentPlan.tasks.find((t) => t.id === event.taskId);
        emit({
          type: "task_started",
          taskId: event.taskId,
          tool: task?.tool,
          agent: event.agent,
          attempt: event.attempt,
        });
      } else if (event.type === "task_failed") {
        emit({ type: "task_failed", taskId: event.taskId, error: event.error, willRetry: event.willRetry });
      } else if (event.type === "replan") {
        pendingReplan = {
          fromRevision: event.fromRevision,
          toRevision: event.toRevision,
          reason: event.reason,
        };
      }
    },
  });

  writer.write({
    kind: "summary",
    ok: outcome.ok,
    totalTokens: outcome.record.totalTokens,
    costUsd: outcome.record.costUsd,
    ...(outcome.record.finalOutput === undefined ? {} : { finalOutput: outcome.record.finalOutput }),
    completedAt: now().toISOString(),
  });

  const finalPlan = outcome.record.planRevisions.at(-1) ?? planned.plan;
  const inventory = outputOfKind<InventoryOutput>(outcome.state, "inventory");
  const reorder = outputOfKind<ReorderOutput>(outcome.state, "reorder");
  const compliance = outputOfKind<ComplianceOutput>(outcome.state, "compliance");
  const notification = outputOfKind<NotificationOutput>(outcome.state, "notification");
  const manualReview = outputOfKind<ManualReviewOutput>(outcome.state, "manual_review");
  const elapsedMs = Date.now() - started;

  const reportPath = join(runDir, `${runId}.html`);
  writeFileSync(
    reportPath,
    renderRunReport({
      record: outcome.record,
      state: outcome.state,
      warehouse,
      model: options.llm.name,
      elapsedMs,
      ...(reorder === undefined ? {} : { reorder }),
      ...(compliance === undefined ? {} : { compliance }),
      ...(notification === undefined ? {} : { notification }),
      ...(manualReview === undefined ? {} : { manualReview }),
    }),
    "utf8",
  );

  return {
    runId,
    ok: outcome.ok,
    goal,
    model: options.llm.name,
    warehouse,
    record: outcome.record,
    state: outcome.state,
    initialPlan: planned.plan,
    finalPlan,
    ...(inventory === undefined ? {} : { inventory }),
    ...(reorder === undefined ? {} : { reorder }),
    ...(compliance === undefined ? {} : { compliance }),
    ...(notification === undefined ? {} : { notification }),
    ...(manualReview === undefined ? {} : { manualReview }),
    runLogPath: writer.path,
    reportPath,
    outboxDir: join(outboxDir, runId),
    elapsedMs,
  };
}
