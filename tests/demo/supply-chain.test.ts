/**
 * End-to-end: the demo exactly as `npm run demo` runs it, against the
 * recorded fixtures, with no network.
 *
 * This is the test that keeps the screen-share honest. If a change breaks the
 * demo, CI goes red before anyone discovers it live.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEMO_FIXTURE_DIR, runSupplyChainDemo, type DemoEvent } from "../../src/demo/supply-chain.js";
import { createLlmClient } from "../../src/llm/index.js";
import { loadRunRecord } from "../../src/observability/runlog.js";

let dir: string;
let outboxDir: string;
let runDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcpx-demo-"));
  outboxDir = join(dir, "outbox");
  runDir = join(dir, "runs");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const offline = () => createLlmClient({ mode: "fixture", fixtureDir: DEMO_FIXTURE_DIR, env: {} });

describe("supply-chain demo, offline", () => {
  it("has recorded fixtures for both scenarios", () => {
    const files = readdirSync(DEMO_FIXTURE_DIR);

    expect(files).toContain("plan.json");
    expect(files.some((f) => f.startsWith("replan-"))).toBe(true);
  });

  it("plans a tool-bound DAG with a parallel wave, then executes every tool", async () => {
    const events: DemoEvent[] = [];
    const result = await runSupplyChainDemo({
      llm: offline(),
      outboxDir,
      runDir,
      runId: "run-happy",
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(result.initialPlan.tasks.every((t) => t.tool !== undefined)).toBe(true);

    const planned = events.find((e): e is Extract<DemoEvent, { type: "planned" }> => e.type === "planned");
    expect(planned?.waves.some((wave) => wave.length > 1)).toBe(true);

    expect(result.reorder?.lines).toHaveLength(6);
    expect(result.compliance?.breaches.map((b) => b.rule).sort()).toEqual(
      ["approval_threshold", "hazmat_certification", "supplier_on_hold"].sort(),
    );
  });

  it("writes real purchase orders with the correct values", async () => {
    const result = await runSupplyChainDemo({ llm: offline(), outboxDir, runDir, runId: "run-po" });

    expect(result.notification?.orders.map((o) => `${o.supplierId}:${o.valueUsd}`).sort()).toEqual([
      "SUP-ACME:2450",
      "SUP-NOVA:214",
    ]);
    expect(readdirSync(join(outboxDir, "run-po")).sort()).toEqual(["PO-SUP-ACME.md", "PO-SUP-NOVA.md"]);
  });

  it("routes every task to the specialist that owns its tool", async () => {
    const result = await runSupplyChainDemo({ llm: offline(), outboxDir, runDir, runId: "run-route" });
    const owner: Record<string, string> = {
      check_inventory: "research",
      lookup_suppliers: "research",
      compute_reorder_qty: "compute",
      validate_compliance: "compute",
      notify_supplier: "publish",
    };

    for (const task of result.finalPlan.tasks) {
      expect(result.state.tasks.get(task.id)?.agent, task.id).toBe(owner[task.tool ?? ""]);
    }
  });

  it("persists a run that replays from disk and an HTML report", async () => {
    const result = await runSupplyChainDemo({ llm: offline(), outboxDir, runDir, runId: "run-persist" });

    const restored = loadRunRecord("run-persist", runDir);
    expect(restored.events).toHaveLength(result.record.events.length);

    const html = readFileSync(result.reportPath, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Purchase orders written");
    expect(html).toContain("run-persist");
  });

  it("repairs itself when a supplier portal is down", async () => {
    const events: DemoEvent[] = [];
    const result = await runSupplyChainDemo({
      llm: offline(),
      failPortal: true,
      outboxDir,
      runDir,
      runId: "run-fail",
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(result.record.planRevisions).toHaveLength(2);
    expect(result.finalPlan.tasks.some((t) => t.tool === "queue_manual_review")).toBe(true);
    expect(result.finalPlan.tasks.some((t) => t.tool === "notify_supplier")).toBe(false);

    // Nothing was sent: the send is all-or-nothing, and the replan queued the work instead.
    expect(result.notification).toBeUndefined();
    expect(existsSync(join(outboxDir, "run-fail", "manual-review.md"))).toBe(true);
    expect(existsSync(join(outboxDir, "run-fail", "PO-SUP-ACME.md"))).toBe(false);

    const replan = events.find((e): e is Extract<DemoEvent, { type: "replan" }> => e.type === "replan");
    // Announced with the NEW route, not the one that just failed.
    expect(replan?.plan.revision).toBe(1);
    expect(replan?.plan.tasks.some((t) => t.tool === "queue_manual_review")).toBe(true);
  });

  it("does not re-run completed work after the repair", async () => {
    const result = await runSupplyChainDemo({
      llm: offline(),
      failPortal: true,
      outboxDir,
      runDir,
      runId: "run-carry",
    });

    const starts = result.record.events.filter((e) => e.type === "task_started");
    const inventoryTask = result.finalPlan.tasks.find((t) => t.tool === "check_inventory")?.id;

    expect(starts.filter((e) => e.type === "task_started" && e.taskId === inventoryTask)).toHaveLength(1);
  });

  it("reports a goal with no recording as a clear fixture error", async () => {
    await expect(
      runSupplyChainDemo({ llm: offline(), goal: "an unrecorded goal", outboxDir, runDir, runId: "run-x" }),
    ).rejects.toThrow(/No fixture matches/);
  });
});
