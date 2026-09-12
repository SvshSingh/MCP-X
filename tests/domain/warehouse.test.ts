import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeReorderLines,
  findLowStock,
  formatUsd,
  groupBySupplier,
  loadWarehouse,
  validateCompliance,
  type ReorderLine,
  type Supplier,
} from "../../src/domain/supply-chain/warehouse.js";

const warehouse = loadWarehouse();

const supplier = (over: Partial<Supplier> = {}): Supplier => ({
  id: "SUP-X",
  name: "Supplier X",
  email: "x@supplier.example",
  status: "active",
  certifications: [],
  portal: "up",
  ...over,
});

const line = (over: Partial<ReorderLine> = {}): ReorderLine => ({
  sku: "SKU-1",
  name: "Item",
  supplierId: "SUP-X",
  position: 0,
  target: 10,
  qty: 10,
  casePack: 1,
  unitCostUsd: 1,
  lineValueUsd: 10,
  hazmat: false,
  coldChain: false,
  ...over,
});

describe("loadWarehouse", () => {
  it("loads and validates the bundled demo dataset", () => {
    expect(warehouse.warehouse).toBe("PUNE-DC-01");
    expect(warehouse.skus).toHaveLength(8);
    expect(warehouse.suppliers).toHaveLength(3);
  });

  it("rejects a SKU whose supplier does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpx-wh-"));
    try {
      const broken = { ...warehouse, skus: [{ ...warehouse.skus[0], supplierId: "SUP-GHOST" }] };
      const path = join(dir, "warehouse.json");
      writeFileSync(path, JSON.stringify(broken), "utf8");

      expect(() => loadWarehouse(path)).toThrow(/unknown supplier SUP-GHOST/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findLowStock", () => {
  it("finds the six SKUs at or below reorder point in the demo data", () => {
    expect(findLowStock(warehouse).map((item) => item.sku)).toEqual([
      "AMX-500",
      "INS-GLA",
      "ETH-70",
      "SYR-5ML",
      "MAB-100",
      "ORS-21",
    ]);
  });

  it("measures inventory position, counting stock already on order", () => {
    const orsOnHandOnly = warehouse.skus.find((s) => s.sku === "ORS-21");
    const gloves = findLowStock(warehouse).find((s) => s.sku === "GLV-NIT-M");

    expect(findLowStock(warehouse).find((s) => s.sku === "ORS-21")?.position).toBe(
      (orsOnHandOnly?.onHand ?? 0) + (orsOnHandOnly?.onOrder ?? 0),
    );
    // Gloves have 2,200 on hand and 400 on order against a reorder point of
    // 1,000: nowhere near low. Re-ordering on on-hand stock alone is the classic
    // way a replenishment script orders goods that are already on a truck.
    expect(gloves).toBeUndefined();
  });
});

describe("computeReorderLines", () => {
  const lines = computeReorderLines(findLowStock(warehouse), warehouse.reviewPeriodDays);
  const qty = (sku: string) => lines.find((l) => l.sku === sku)?.qty;

  it("computes order-up-to quantities for the demo data", () => {
    // target = ceil(demand * (lead + review) + safety); qty = target - position, up to a case.
    expect(qty("AMX-500")).toBe(800); // ceil(60*12 + 200) = 920; 920 - 120 = 800
    expect(qty("INS-GLA")).toBe(100); // ceil(8*11 + 50) = 138; 98 -> 10s -> 100
    expect(qty("ETH-70")).toBe(60); // ceil(5*13 + 20) = 85; 55 -> 12s -> 60
    expect(qty("SYR-5ML")).toBe(2000); // 2500 - 900 = 1600 -> 500s -> 2000
    expect(qty("MAB-100")).toBe(30); // ceil(1.5*17 + 8) = 34; 28 -> 5s -> 30
    expect(qty("ORS-21")).toBe(200); // ceil(25*11 + 150) = 425; 425 - 230 = 195 -> 50s -> 200
  });

  it("rounds up to a whole case, never down", () => {
    for (const l of lines) {
      expect(l.qty % l.casePack, l.sku).toBe(0);
      expect(l.qty, l.sku).toBeGreaterThanOrEqual(l.target - l.position);
    }
  });

  it("values each line at unit cost", () => {
    expect(lines.find((l) => l.sku === "MAB-100")?.lineValueUsd).toBe(14400);
  });

  it("drops a line whose position already meets its target", () => {
    const item = { ...findLowStock(warehouse)[0]!, onHand: 10000, position: 10000 };

    expect(computeReorderLines([item], 7)).toEqual([]);
  });
});

describe("validateCompliance", () => {
  it("approves a clean line", () => {
    const result = validateCompliance([line()], [supplier()], 5000);

    expect(result.approved).toHaveLength(1);
    expect(result.breaches).toEqual([]);
    expect(result.approvedValueUsd).toBe(10);
  });

  it("holds a line from a supplier on hold", () => {
    const result = validateCompliance([line()], [supplier({ status: "on_hold" })], 5000);

    expect(result.breaches.map((b) => b.rule)).toEqual(["supplier_on_hold"]);
    expect(result.approved).toEqual([]);
  });

  it("requires HAZMAT certification for hazardous goods", () => {
    const result = validateCompliance([line({ hazmat: true })], [supplier()], 5000);

    expect(result.breaches.map((b) => b.rule)).toEqual(["hazmat_certification"]);
  });

  it("requires cold-chain certification for cold-chain goods", () => {
    const certified = validateCompliance(
      [line({ coldChain: true })],
      [supplier({ certifications: ["COLD_CHAIN"] })],
      5000,
    );
    const uncertified = validateCompliance([line({ coldChain: true })], [supplier()], 5000);

    expect(certified.breaches).toEqual([]);
    expect(uncertified.breaches.map((b) => b.rule)).toEqual(["cold_chain_certification"]);
  });

  it("holds a line above the auto-approval threshold", () => {
    const result = validateCompliance([line({ lineValueUsd: 14400 })], [supplier()], 5000);

    expect(result.breaches[0]?.rule).toBe("approval_threshold");
    expect(result.breaches[0]?.detail).toContain("$14,400.00");
  });

  it("flags a line whose supplier has no record", () => {
    const result = validateCompliance([line({ supplierId: "SUP-GHOST" })], [supplier()], 5000);

    expect(result.breaches.map((b) => b.rule)).toEqual(["supplier_not_found"]);
  });

  it("reports every rule a line breaks, not just the first", () => {
    const result = validateCompliance(
      [line({ hazmat: true, coldChain: true, lineValueUsd: 9999 })],
      [supplier({ status: "on_hold" })],
      5000,
    );

    // A reviewer should see everything wrong in one pass.
    expect(result.breaches.map((b) => b.rule).sort()).toEqual(
      ["approval_threshold", "cold_chain_certification", "hazmat_certification", "supplier_on_hold"].sort(),
    );
  });

  it("produces exactly the three breaches the demo is designed to show", () => {
    const lines = computeReorderLines(findLowStock(warehouse), warehouse.reviewPeriodDays);
    const result = validateCompliance(lines, warehouse.suppliers, warehouse.approvalThresholdUsd);

    expect(result.breaches.map((b) => `${b.sku}:${b.rule}`).sort()).toEqual(
      ["ETH-70:hazmat_certification", "MAB-100:approval_threshold", "SYR-5ML:supplier_on_hold"].sort(),
    );
    expect(result.approved.map((l) => l.sku).sort()).toEqual(["AMX-500", "INS-GLA", "ORS-21"]);
    expect(result.approvedValueUsd).toBe(2664);
  });
});

describe("groupBySupplier", () => {
  it("groups lines into one order per supplier", () => {
    const grouped = groupBySupplier([
      line({ sku: "A", supplierId: "S1" }),
      line({ sku: "B", supplierId: "S2" }),
      line({ sku: "C", supplierId: "S1" }),
    ]);

    expect([...grouped.keys()]).toEqual(["S1", "S2"]);
    expect(grouped.get("S1")?.map((l) => l.sku)).toEqual(["A", "C"]);
  });
});

describe("formatUsd", () => {
  it("groups thousands and fixes two decimals", () => {
    expect(formatUsd(17376)).toBe("$17,376.00");
    expect(formatUsd(0.5)).toBe("$0.50");
  });
});
