import { describe, expect, it } from "vitest";

import { findLowStock, computeReorderLines, loadWarehouse, validateCompliance } from "../../src/domain/supply-chain/warehouse.js";
import { deriveState } from "../../src/kernel/blackboard.js";
import { Plan, RunRecord, type Event } from "../../src/kernel/schemas.js";
import { escapeHtml, renderRunReport } from "../../src/observability/html-report.js";

const AT = "2026-09-13T10:00:00.000Z";
const warehouse = loadWarehouse();
const lines = computeReorderLines(findLowStock(warehouse), warehouse.reviewPeriodDays);
const compliance = {
  kind: "compliance" as const,
  ...validateCompliance(lines, warehouse.suppliers, warehouse.approvalThresholdUsd),
  supplierSource: "upstream" as const,
};

function reportFor(options: { goal?: string; replan?: boolean } = {}) {
  const goal = options.goal ?? "Restock the warehouse";
  const plan0 = Plan.parse({
    goal,
    tasks: [{ id: "inv", description: "check", tool: "check_inventory" }],
    createdAt: AT,
    revision: 0,
  });
  const plan1 = Plan.parse({ ...plan0, revision: 1 });
  const events: Event[] = [
    { type: "plan_created", runId: "run-r", at: AT, revision: 0, taskCount: 1 },
    ...(options.replan
      ? [{ type: "replan" as const, runId: "run-r", at: AT, fromRevision: 0, toRevision: 1, reason: "portal down", triggeredByTaskId: "send" }]
      : []),
    { type: "run_completed", runId: "run-r", at: AT, ok: true },
  ];
  const revisions = options.replan ? [plan0, plan1] : [plan0];
  const record = RunRecord.parse({ runId: "run-r", goal, planRevisions: revisions, events, startedAt: AT });

  return renderRunReport({
    record,
    state: deriveState(revisions.at(-1)!, events),
    warehouse,
    model: "fixture",
    elapsedMs: 1234,
    reorder: { kind: "reorder", reviewPeriodDays: 7, lines, totalValueUsd: 0 },
    compliance,
  });
}

describe("escapeHtml", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
  });
});

describe("renderRunReport", () => {
  it("renders a complete standalone page", () => {
    const html = reportFor();

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Restock the warehouse");
    expect(html).toContain("Succeeded");
  });

  it("labels an offline replay rather than showing the internal client name", () => {
    expect(reportFor()).toContain("recorded model output (offline replay)");
  });

  it("shows every compliance decision with its reason", () => {
    const html = reportFor();

    expect(html).toContain("HAZMAT certification");
    expect(html).toContain("Supplier on hold");
    expect(html).toContain("Needs approval");
    expect(html).toContain("$14,400.00");
  });

  it("explains a self-repair only when one happened", () => {
    expect(reportFor({ replan: true })).toContain("The run repaired itself");
    expect(reportFor({ replan: false })).not.toContain("The run repaired itself");
  });

  it("escapes a goal that contains markup", () => {
    const html = reportFor({ goal: `<script>alert("x")</script>` });

    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;");
  });

  it("loads nothing from the network", () => {
    expect(reportFor()).not.toMatch(/https?:\/\//);
  });
});
