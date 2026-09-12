/**
 * A toy pharmaceutical distribution centre: the dataset, and the pure
 * functions that reason over it.
 *
 * Everything here is deterministic and free of I/O apart from the loader, so
 * the numbers the demo shows on screen are the same numbers the tests assert.
 * The tools in `tools.ts` are thin wrappers that add MCP framing and the one
 * real side effect (writing purchase orders to an outbox).
 *
 * Phase 9 of ORCHESTRATOR_PLAN.md.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

export const Supplier = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  status: z.enum(["active", "on_hold"]),
  certifications: z.array(z.string()).default([]),
  /** Whether the supplier's ordering portal accepts purchase orders right now. */
  portal: z.enum(["up", "down"]).default("up"),
});
export type Supplier = z.infer<typeof Supplier>;

export const Sku = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  onHand: z.number().min(0),
  onOrder: z.number().min(0).default(0),
  reorderPoint: z.number().min(0),
  safetyStock: z.number().min(0),
  avgDailyDemand: z.number().min(0),
  leadTimeDays: z.number().min(0),
  casePack: z.number().int().min(1),
  unitCostUsd: z.number().min(0),
  supplierId: z.string().min(1),
  hazmat: z.boolean().default(false),
  coldChain: z.boolean().default(false),
});
export type Sku = z.infer<typeof Sku>;

export const Warehouse = z
  .object({
    warehouse: z.string().min(1),
    asOf: z.string().min(1),
    currency: z.string().default("USD"),
    reviewPeriodDays: z.number().min(0),
    approvalThresholdUsd: z.number().min(0),
    suppliers: z.array(Supplier).min(1),
    skus: z.array(Sku).min(1),
  })
  .superRefine((data, ctx) => {
    const supplierIds = new Set(data.suppliers.map((s) => s.id));
    for (const sku of data.skus) {
      if (!supplierIds.has(sku.supplierId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["skus"],
          message: `SKU ${sku.sku} references unknown supplier ${sku.supplierId}`,
        });
      }
    }
  });
export type Warehouse = z.infer<typeof Warehouse>;

export const DEFAULT_WAREHOUSE_PATH = join(process.cwd(), "demo", "warehouse.json");

export function loadWarehouse(path: string = DEFAULT_WAREHOUSE_PATH): Warehouse {
  const parsed = Warehouse.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `Invalid warehouse dataset "${path}": ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

export interface LowStockItem extends Sku {
  /** On hand plus already on order: what the reorder decision is made against. */
  position: number;
}

/**
 * SKUs at or below their reorder point.
 *
 * Measured on inventory *position* (on hand + on order), not on hand alone.
 * Reordering on on-hand stock re-orders goods that are already on a truck,
 * which is the classic way a naive replenishment script doubles an order.
 */
export function findLowStock(warehouse: Warehouse): LowStockItem[] {
  return warehouse.skus
    .map((sku) => ({ ...sku, position: sku.onHand + sku.onOrder }))
    .filter((sku) => sku.position <= sku.reorderPoint);
}

/* -------------------------------------------------------------------------- */
/* Reorder quantities                                                         */
/* -------------------------------------------------------------------------- */

export interface ReorderLine {
  sku: string;
  name: string;
  supplierId: string;
  position: number;
  /** Stock level the order should restore: demand over lead time + review period, plus safety stock. */
  target: number;
  qty: number;
  casePack: number;
  unitCostUsd: number;
  lineValueUsd: number;
  hazmat: boolean;
  coldChain: boolean;
}

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

export const formatUsd = (value: number): string =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Periodic-review, order-up-to replenishment.
 *
 *   target = ceil(avgDailyDemand × (leadTimeDays + reviewPeriodDays) + safetyStock)
 *   qty    = (target − position), rounded UP to a whole case pack
 *
 * Rounding up rather than to nearest is deliberate: rounding down on a
 * pharmaceutical line under-orders safety stock, and a stock-out of a
 * cold-chain product costs far more than a partial extra case.
 */
export function computeReorderLines(
  items: readonly LowStockItem[],
  reviewPeriodDays: number,
): ReorderLine[] {
  return items
    .map((item) => {
      const target = Math.ceil(
        item.avgDailyDemand * (item.leadTimeDays + reviewPeriodDays) + item.safetyStock,
      );
      const shortfall = Math.max(0, target - item.position);
      const qty = Math.ceil(shortfall / item.casePack) * item.casePack;

      return {
        sku: item.sku,
        name: item.name,
        supplierId: item.supplierId,
        position: item.position,
        target,
        qty,
        casePack: item.casePack,
        unitCostUsd: item.unitCostUsd,
        lineValueUsd: roundMoney(qty * item.unitCostUsd),
        hazmat: item.hazmat,
        coldChain: item.coldChain,
      };
    })
    .filter((line) => line.qty > 0);
}

/* -------------------------------------------------------------------------- */
/* Compliance                                                                 */
/* -------------------------------------------------------------------------- */

export type ComplianceRule =
  | "supplier_not_found"
  | "supplier_on_hold"
  | "hazmat_certification"
  | "cold_chain_certification"
  | "approval_threshold";

export interface Breach {
  sku: string;
  supplierId: string;
  rule: ComplianceRule;
  detail: string;
}

export interface ComplianceResult {
  approved: ReorderLine[];
  breaches: Breach[];
  approvedValueUsd: number;
}

/**
 * Checks every proposed order line against distribution rules.
 *
 * A line with any breach is withheld entirely rather than partially sent.
 * Every rule is evaluated even after the first breach, so a reviewer sees
 * everything wrong with a line in one pass instead of fixing it rule by rule.
 */
export function validateCompliance(
  lines: readonly ReorderLine[],
  suppliers: readonly Supplier[],
  approvalThresholdUsd: number,
): ComplianceResult {
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const approved: ReorderLine[] = [];
  const breaches: Breach[] = [];

  for (const line of lines) {
    const found: Breach[] = [];
    const supplier = byId.get(line.supplierId);
    const breach = (rule: ComplianceRule, detail: string) =>
      found.push({ sku: line.sku, supplierId: line.supplierId, rule, detail });

    if (!supplier) {
      breach("supplier_not_found", `No supplier record for ${line.supplierId}`);
    } else {
      if (supplier.status !== "active") {
        breach("supplier_on_hold", `${supplier.name} is on hold and cannot receive orders`);
      }
      if (line.hazmat && !supplier.certifications.includes("HAZMAT")) {
        breach("hazmat_certification", `${line.sku} is hazardous; ${supplier.name} is not HAZMAT-certified`);
      }
      if (line.coldChain && !supplier.certifications.includes("COLD_CHAIN")) {
        breach("cold_chain_certification", `${line.sku} needs cold chain; ${supplier.name} is not certified`);
      }
    }

    if (line.lineValueUsd > approvalThresholdUsd) {
      breach(
        "approval_threshold",
        `${formatUsd(line.lineValueUsd)} exceeds the ${formatUsd(approvalThresholdUsd)} auto-approval limit`,
      );
    }

    if (found.length === 0) approved.push(line);
    else breaches.push(...found);
  }

  return {
    approved,
    breaches,
    approvedValueUsd: roundMoney(approved.reduce((sum, line) => sum + line.lineValueUsd, 0)),
  };
}

/** Groups approved lines into one purchase order per supplier. */
export function groupBySupplier(lines: readonly ReorderLine[]): Map<string, ReorderLine[]> {
  const grouped = new Map<string, ReorderLine[]>();
  for (const line of lines) {
    const existing = grouped.get(line.supplierId) ?? [];
    existing.push(line);
    grouped.set(line.supplierId, existing);
  }
  return grouped;
}
