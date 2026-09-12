import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findUpstream,
  makeSupplyChainTools,
  type ComplianceOutput,
  type InventoryOutput,
  type NotificationOutput,
  type ReorderOutput,
} from "../../src/domain/supply-chain/tools.js";
import { loadWarehouse, type Warehouse } from "../../src/domain/supply-chain/warehouse.js";
import type { ToolDefinition, ToolResult } from "../../src/mcp/tool-types.js";

let outbox: string;
const baseWarehouse = loadWarehouse();

beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), "mcpx-outbox-"));
});
afterEach(() => {
  rmSync(outbox, { recursive: true, force: true });
});

function toolsFor(options: { warehouse?: Warehouse; portalDown?: string[] } = {}) {
  const tools = makeSupplyChainTools({
    loadWarehouse: () => options.warehouse ?? baseWarehouse,
    outboxDir: outbox,
    now: () => new Date("2026-09-13T10:00:00.000Z"),
    portalDown: options.portalDown ?? [],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byName = new Map(tools.map((t) => [t.name, t] as [string, ToolDefinition<any>]));
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    byName.get(name)!.handler(args);
  return { tools, call };
}

const data = <T>(result: ToolResult) => result.structuredContent as unknown as T;

/** Runs the pipeline up to compliance, returning each stage's output. */
async function upToCompliance(call: ReturnType<typeof toolsFor>["call"]) {
  const inventory = data<InventoryOutput>(await call("check_inventory"));
  const suppliers = data(await call("lookup_suppliers", { upstream: { inv: inventory } }));
  const reorder = data<ReorderOutput>(await call("compute_reorder_qty", { upstream: { inv: inventory } }));
  const compliance = data<ComplianceOutput>(
    await call("validate_compliance", { upstream: { r: reorder, s: suppliers } }),
  );
  return { inventory, suppliers, reorder, compliance };
}

describe("tool metadata", () => {
  it("declares the data each tool produces and consumes", () => {
    const { tools } = toolsFor();
    const io = Object.fromEntries(tools.map((t) => [t.name, { produces: t.produces, consumes: t.consumes }]));

    expect(io).toEqual({
      check_inventory: { produces: "inventory", consumes: undefined },
      lookup_suppliers: { produces: "suppliers", consumes: ["inventory"] },
      compute_reorder_qty: { produces: "reorder", consumes: ["inventory"] },
      validate_compliance: { produces: "compliance", consumes: ["reorder"] },
      notify_supplier: { produces: "notification", consumes: ["compliance"] },
      queue_manual_review: { produces: "manual_review", consumes: ["compliance"] },
    });
  });
});

describe("findUpstream", () => {
  it("finds a dependency's output by kind", () => {
    expect(findUpstream({ a: { kind: "x", v: 1 }, b: { kind: "y", v: 2 } }, "y")).toEqual({ kind: "y", v: 2 });
  });

  it("returns undefined when nothing matches", () => {
    expect(findUpstream({ a: { kind: "x" }, b: null, c: 3 }, "y")).toBeUndefined();
    expect(findUpstream(undefined, "y")).toBeUndefined();
  });
});

describe("pipeline tools", () => {
  it("check_inventory returns structured low-stock data", async () => {
    const { call } = toolsFor();
    const result = await call("check_inventory");

    expect(result.isError).toBeUndefined();
    expect(data<InventoryOutput>(result).lowStock).toHaveLength(6);
    expect(result.content[0]?.text).toContain("6 of 8 SKUs");
  });

  it("each consuming tool refuses to run without its upstream data", async () => {
    const { call } = toolsFor();

    for (const name of ["lookup_suppliers", "compute_reorder_qty", "validate_compliance", "notify_supplier", "queue_manual_review"]) {
      const result = await call(name, { upstream: {} });
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain("must list that task in dependsOn");
    }
  });

  it("lookup_suppliers returns only the suppliers of low-stock items", async () => {
    const { call } = toolsFor();
    const inventory = data<InventoryOutput>(await call("check_inventory"));
    const result = await call("lookup_suppliers", { upstream: { i: inventory } });

    expect(data<{ suppliers: { id: string }[] }>(result).suppliers.map((s) => s.id).sort()).toEqual([
      "SUP-ACME",
      "SUP-NOVA",
      "SUP-ORBIT",
    ]);
  });

  it("validate_compliance says where supplier data came from", async () => {
    const { call } = toolsFor();
    const inventory = data<InventoryOutput>(await call("check_inventory"));
    const reorder = data<ReorderOutput>(await call("compute_reorder_qty", { upstream: { i: inventory } }));

    const withoutLookup = data<ComplianceOutput>(await call("validate_compliance", { upstream: { r: reorder } }));
    expect(withoutLookup.supplierSource).toBe("master data");

    const { compliance } = await upToCompliance(call);
    expect(compliance.supplierSource).toBe("upstream");
    expect(compliance.breaches).toHaveLength(3);
  });
});

describe("notify_supplier", () => {
  it("writes one purchase order per supplier into the run's outbox folder", async () => {
    const { call } = toolsFor();
    const { compliance } = await upToCompliance(call);

    const result = await call("notify_supplier", { upstream: { c: compliance }, runId: "run-test" });
    const orders = data<NotificationOutput>(result).orders;

    expect(orders.map((o) => `${o.supplierId}:${o.valueUsd}`).sort()).toEqual(["SUP-ACME:2450", "SUP-NOVA:214"]);
    expect(readdirSync(join(outbox, "run-test")).sort()).toEqual(["PO-SUP-ACME.md", "PO-SUP-NOVA.md"]);

    const po = readFileSync(join(outbox, "run-test", "PO-SUP-NOVA.md"), "utf8");
    expect(po).toContain("AMX-500");
    expect(po).toContain("ORS-21");
    expect(po).toContain("nothing was transmitted");
  });

  it("writes generated documents as plain ASCII", async () => {
    const { call } = toolsFor();
    const { compliance } = await upToCompliance(call);
    await call("notify_supplier", { upstream: { c: compliance }, runId: "run-ascii" });

    // A non-ASCII dash renders as mojibake when a Windows console prints a
    // UTF-8 file, which is precisely what happens during a screen share.
    for (const file of readdirSync(join(outbox, "run-ascii"))) {
      const text = readFileSync(join(outbox, "run-ascii", file), "utf8");
      expect([...text].every((ch) => ch.charCodeAt(0) < 128), file).toBe(true);
    }
  });

  it("sends nothing at all when any portal is down", async () => {
    const { call } = toolsFor({ portalDown: ["SUP-NOVA"] });
    const { compliance } = await upToCompliance(call);

    const result = await call("notify_supplier", { upstream: { c: compliance }, runId: "run-down" });

    // All-or-nothing: a partial send is the one outcome a replan cannot repair.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("SUP-NOVA");
    expect(existsSync(join(outbox, "run-down"))).toBe(false);
  });

  it("honours a portal marked down in the dataset itself", async () => {
    const warehouse: Warehouse = {
      ...baseWarehouse,
      suppliers: baseWarehouse.suppliers.map((s) => (s.id === "SUP-ACME" ? { ...s, portal: "down" as const } : s)),
    };
    const { call } = toolsFor({ warehouse });
    const { compliance } = await upToCompliance(call);

    expect((await call("notify_supplier", { upstream: { c: compliance } })).isError).toBe(true);
  });

  it("reports success with no orders when nothing was approved", async () => {
    const { call } = toolsFor();
    const empty: ComplianceOutput = {
      kind: "compliance",
      approved: [],
      breaches: [],
      approvedValueUsd: 0,
      supplierSource: "master data",
    };

    const result = await call("notify_supplier", { upstream: { c: empty } });

    expect(result.isError).toBeUndefined();
    expect(data<NotificationOutput>(result).orders).toEqual([]);
  });
});

describe("queue_manual_review", () => {
  it("writes the lines to place and the breaches to resolve", async () => {
    const { call } = toolsFor();
    const { compliance } = await upToCompliance(call);

    const result = await call("queue_manual_review", { upstream: { c: compliance }, runId: "run-review" });
    const file = readFileSync(join(outbox, "run-review", "manual-review.md"), "utf8");

    expect(result.isError).toBeUndefined();
    expect(file).toContain("AMX-500");
    expect(file).toContain("HAZMAT");
    expect(file).toContain("on hold");
  });

  it("uses an adhoc folder when no run id is given", async () => {
    const { call } = toolsFor();
    const { compliance } = await upToCompliance(call);

    await call("queue_manual_review", { upstream: { c: compliance } });

    expect(existsSync(join(outbox, "adhoc", "manual-review.md"))).toBe(true);
  });
});
