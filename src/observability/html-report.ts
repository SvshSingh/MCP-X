/**
 * A single self-contained HTML page for one supply-chain run.
 *
 * Built for being looked at, not parsed: a screen share of a terminal full of
 * JSONL shows that a run happened, while this shows what it decided — the
 * plan as parallel waves, which specialist ran which tool, what compliance
 * held back and why, the purchase orders written, and any repair the run made
 * to itself. No scripts, no network, no dependencies; it opens from disk.
 *
 * Everything here is derived from the RunRecord and the tools' structured
 * outputs, so the page can never claim something the record does not.
 */

import type { ComplianceOutput, ManualReviewOutput, NotificationOutput, ReorderOutput } from "../domain/supply-chain/tools.js";
import type { Warehouse } from "../domain/supply-chain/warehouse.js";
import type { RunState } from "../kernel/blackboard.js";
import { executionWaves } from "../kernel/scheduler.js";
import type { Event, Plan, RunRecord } from "../kernel/schemas.js";

export interface RunReportInput {
  record: RunRecord;
  state: RunState;
  warehouse: Warehouse;
  model: string;
  elapsedMs: number;
  reorder?: ReorderOutput;
  compliance?: ComplianceOutput;
  notification?: NotificationOutput;
  manualReview?: ManualReviewOutput;
}

export const escapeHtml = (value: unknown): string =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_LABEL: Record<string, string> = {
  completed: "done",
  failed: "failed",
  blocked: "blocked",
  pending: "not run",
  running: "running",
};

const RULE_LABEL: Record<string, string> = {
  supplier_not_found: "Unknown supplier",
  supplier_on_hold: "Supplier on hold",
  hazmat_certification: "HAZMAT certification",
  cold_chain_certification: "Cold-chain certification",
  approval_threshold: "Needs approval",
};

function describeEvent(event: Event): string {
  switch (event.type) {
    case "plan_created":
      return `Plan revision ${event.revision} created with ${event.taskCount} tasks`;
    case "task_started":
      return `<code>${escapeHtml(event.taskId)}</code> started on <b>${escapeHtml(event.agent)}</b> (attempt ${event.attempt})`;
    case "task_completed":
      return `<code>${escapeHtml(event.taskId)}</code> — ${escapeHtml(event.result.output ?? "done")}`;
    case "task_failed":
      return `<code>${escapeHtml(event.taskId)}</code> failed${event.willRetry ? ", will retry" : ""}: ${escapeHtml(event.error)}`;
    case "replan":
      return `Replanned ${event.fromRevision} → ${event.toRevision}: ${escapeHtml(event.reason)}`;
    case "run_completed":
      return event.ok ? "Run completed" : "Run ended with failures";
  }
}

function renderPlan(plan: Plan, state: RunState, isFinal: boolean): string {
  const waves = executionWaves(plan);
  return `
    <section class="card">
      <h3>Plan revision ${plan.revision}${isFinal ? " <span class=\"pill\">executed</span>" : " <span class=\"pill muted\">superseded</span>"}</h3>
      <div class="waves">
        ${waves
          .map(
            (wave, index) => `
          <div class="wave">
            <div class="wave-label">Wave ${index + 1}${wave.length > 1 ? ` · ${wave.length} in parallel` : ""}</div>
            ${wave
              .map((task) => {
                const taskState = state.tasks.get(task.id);
                const status = isFinal ? (taskState?.status ?? "pending") : "superseded";
                return `
              <div class="task status-${escapeHtml(status)}">
                <div class="task-id">${escapeHtml(task.id)}</div>
                <div class="task-tool">${escapeHtml(task.tool ?? "no tool")}</div>
                <div class="task-meta">${escapeHtml(taskState?.agent ?? task.agentHint ?? "")} · ${escapeHtml(STATUS_LABEL[status] ?? status)}</div>
              </div>`;
              })
              .join("")}
          </div>`,
          )
          .join("")}
      </div>
    </section>`;
}

export function renderRunReport(input: RunReportInput): string {
  const { record, state, warehouse, reorder, compliance, notification, manualReview } = input;
  const ok = record.events.some((e) => e.type === "run_completed" && e.ok);
  const finalPlan = record.planRevisions.at(-1);
  const replans = record.events.filter((e): e is Extract<Event, { type: "replan" }> => e.type === "replan");

  const ordersSection = notification
    ? `
    <section class="card">
      <h3>Purchase orders written</h3>
      ${
        notification.orders.length === 0
          ? "<p>No approved lines, so no orders were needed.</p>"
          : `<table><thead><tr><th>Supplier</th><th>Lines</th><th class="num">Value</th><th>File</th></tr></thead><tbody>
          ${notification.orders
            .map(
              (o) => `<tr><td><b>${escapeHtml(o.supplierName)}</b><br><span class="muted">${escapeHtml(o.email)}</span></td>
              <td>${o.lines.map((l) => `${escapeHtml(l.sku)} × ${l.qty}`).join("<br>")}</td>
              <td class="num">${usd(o.valueUsd)}</td><td><code>${escapeHtml(o.file)}</code></td></tr>`,
            )
            .join("")}
          </tbody></table>`
      }
    </section>`
    : "";

  const manualSection = manualReview
    ? `
    <section class="card warn">
      <h3>Queued for manual review</h3>
      <p>${escapeHtml(manualReview.reason)}</p>
      <p><code>${escapeHtml(manualReview.file)}</code></p>
    </section>`
    : "";

  const reorderSection = reorder
    ? `
    <section class="card">
      <h3>Reorder quantities</h3>
      <table><thead><tr><th>SKU</th><th>Item</th><th class="num">Position</th><th class="num">Target</th><th class="num">Order</th><th class="num">Value</th><th>Decision</th></tr></thead><tbody>
      ${reorder.lines
        .map((line) => {
          const breaches = compliance?.breaches.filter((b) => b.sku === line.sku) ?? [];
          const decision = !compliance
            ? `<span class="muted">not validated</span>`
            : breaches.length === 0
              ? `<span class="good">approved</span>`
              : breaches.map((b) => `<span class="bad">${escapeHtml(RULE_LABEL[b.rule] ?? b.rule)}</span>`).join("<br>");
          return `<tr><td><code>${escapeHtml(line.sku)}</code></td><td>${escapeHtml(line.name)}${line.coldChain ? ' <span class="tag">cold chain</span>' : ""}${line.hazmat ? ' <span class="tag">hazmat</span>' : ""}</td>
          <td class="num">${line.position}</td><td class="num">${line.target}</td><td class="num"><b>${line.qty}</b></td><td class="num">${usd(line.lineValueUsd)}</td><td>${decision}</td></tr>`;
        })
        .join("")}
      </tbody></table>
      ${
        compliance && compliance.breaches.length > 0
          ? `<ul class="breaches">${compliance.breaches.map((b) => `<li><b>${escapeHtml(b.sku)}</b> — ${escapeHtml(b.detail)}</li>`).join("")}</ul>`
          : ""
      }
    </section>`
    : "";

  const replanSection = replans
    .map(
      (r) => `
    <section class="card warn">
      <h3>The run repaired itself</h3>
      <p><code>${escapeHtml(r.triggeredByTaskId ?? "a task")}</code> failed, so the replanner produced revision ${r.toRevision}.</p>
      <p class="quote">${escapeHtml(r.reason)}</p>
      <p class="muted">Completed tasks were kept and not re-run; the failed task's id cannot reappear in the new plan.</p>
    </section>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP-X run ${escapeHtml(record.runId)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#15181d; --muted:#667085; --line:#e4e7ec; --accent:#3b5bdb;
          --good:#1b7f4b; --good-bg:#e7f6ee; --bad:#b42318; --bad-bg:#fdecea; --warn-bg:#fff7e6; --warn-line:#f5c56b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#171a21; --ink:#e7e9ee; --muted:#98a2b3; --line:#2a2f3a; --accent:#8ea6ff;
            --good:#5dd39e; --good-bg:#12291f; --bad:#ff8a80; --bad-bg:#2c1614; --warn-bg:#2a2210; --warn-line:#8a6a1f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h3 { font-size: 15px; margin: 0 0 12px; }
  .muted { color: var(--muted); }
  .head { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; align-items:flex-start; margin-bottom:18px; }
  .badge { padding:6px 12px; border-radius:999px; font-weight:600; }
  .badge.ok { background:var(--good-bg); color:var(--good); }
  .badge.fail { background:var(--bad-bg); color:var(--bad); }
  .stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:10px; margin-bottom:16px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .stat b { display:block; font-size:18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; overflow-x:auto; }
  .card.warn { background:var(--warn-bg); border-color:var(--warn-line); }
  .pill { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; background:var(--good-bg); color:var(--good); margin-left:6px; }
  .pill.muted { background:var(--line); color:var(--muted); }
  .waves { display:flex; gap:12px; align-items:stretch; }
  .wave { flex:1; min-width:170px; display:flex; flex-direction:column; gap:8px; }
  .wave-label { font-size:12px; color:var(--muted); font-weight:600; }
  .task { border:1px solid var(--line); border-left:4px solid var(--muted); border-radius:8px; padding:8px 10px; }
  .task-id { font-weight:600; word-break: break-word; }
  .task-tool { font-family: ui-monospace, Consolas, monospace; font-size:12px; color:var(--accent); }
  .task-meta { font-size:12px; color:var(--muted); }
  .status-completed { border-left-color: var(--good); }
  .status-failed { border-left-color: var(--bad); }
  .status-blocked, .status-superseded, .status-pending { opacity:.7; }
  table { width:100%; border-collapse: collapse; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); vertical-align: top; }
  th { font-size:12px; color:var(--muted); font-weight:600; }
  .num { text-align:right; font-variant-numeric: tabular-nums; }
  code { font-family: ui-monospace, Consolas, monospace; font-size:12px; }
  .good { color: var(--good); font-weight:600; }
  .bad { color: var(--bad); font-weight:600; }
  .tag { font-size:11px; padding:1px 6px; border-radius:6px; background:var(--line); color:var(--muted); }
  .quote { border-left:3px solid var(--warn-line); padding-left:10px; }
  .breaches { margin: 10px 0 0; padding-left: 18px; }
  .timeline td:first-child { white-space:nowrap; color:var(--muted); font-family: ui-monospace, Consolas, monospace; font-size:12px; }
  @media (max-width: 720px) { .waves { flex-direction: column; } }
</style>
</head>
<body>
<main>
  <div class="head">
    <div>
      <h1>${escapeHtml(record.goal)}</h1>
      <div class="muted">Run <code>${escapeHtml(record.runId)}</code> · ${escapeHtml(warehouse.warehouse)} · data as of ${escapeHtml(warehouse.asOf)} · planner <code>${escapeHtml(input.model === "fixture" ? "recorded model output (offline replay)" : input.model)}</code></div>
    </div>
    <span class="badge ${ok ? "ok" : "fail"}">${ok ? "Succeeded" : "Failed"}</span>
  </div>

  <div class="stats">
    <div class="stat"><span class="muted">Tasks executed</span><b>${[...state.tasks.values()].filter((t) => t.status === "completed").length} / ${finalPlan?.tasks.length ?? 0}</b></div>
    <div class="stat"><span class="muted">Plan revisions</span><b>${record.planRevisions.length}</b></div>
    <div class="stat"><span class="muted">Approved value</span><b>${compliance ? usd(compliance.approvedValueUsd) : "—"}</b></div>
    <div class="stat"><span class="muted">Held back</span><b>${compliance ? `${new Set(compliance.breaches.map((b) => b.sku)).size} line(s)` : "—"}</b></div>
    <div class="stat"><span class="muted">Tokens</span><b>${record.totalTokens.in + record.totalTokens.out}</b></div>
    <div class="stat"><span class="muted">Wall time</span><b>${(input.elapsedMs / 1000).toFixed(2)}s</b></div>
  </div>

  ${replanSection}
  ${record.planRevisions.map((plan, i) => renderPlan(plan, state, i === record.planRevisions.length - 1)).join("")}
  ${reorderSection}
  ${ordersSection}
  ${manualSection}

  <section class="card">
    <h3>Event log (${record.events.length} events, append-only)</h3>
    <table class="timeline"><tbody>
      ${record.events.map((e) => `<tr><td>${escapeHtml(e.at.slice(11, 23))}</td><td>${describeEvent(e)}</td></tr>`).join("")}
    </tbody></table>
  </section>

  <p class="muted">Generated from the run record. Replay it in a terminal with <code>npm run replay -- ${escapeHtml(record.runId)}</code>.</p>
</main>
</body>
</html>
`;
}
