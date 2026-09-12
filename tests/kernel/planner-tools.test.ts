import { describe, expect, it } from "vitest";

import { deriveState } from "../../src/kernel/blackboard.js";
import { createPlan } from "../../src/kernel/planner.js";
import { createReplan } from "../../src/kernel/replanner.js";
import { Plan, type Event } from "../../src/kernel/schemas.js";
import type { ToolCatalogEntry } from "../../src/kernel/tool-catalog.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../../src/llm/types.js";

const AT = "2026-09-13T10:00:00.000Z";
const now = () => new Date(AT);

const catalog: ToolCatalogEntry[] = [
  { name: "check_inventory", description: "reads stock", capability: "research", produces: "inventory" },
  {
    name: "compute_reorder_qty",
    description: "computes orders",
    capability: "compute",
    produces: "reorder",
    consumes: ["inventory"],
  },
  { name: "notify_supplier", description: "sends orders", capability: "publish", consumes: ["reorder"] },
  { name: "queue_manual_review", description: "queues orders", capability: "publish", consumes: ["reorder"] },
];

class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  readonly requests: LlmRequest[] = [];
  #i = 0;
  constructor(private readonly script: readonly string[]) {}
  generate(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.script[Math.min(this.#i, this.script.length - 1)] ?? "";
    this.#i++;
    return Promise.resolve({ text, tokensIn: 10, tokensOut: 5 });
  }
}

const tasks = (list: object[]) => JSON.stringify({ tasks: list });

const wired = [
  { id: "inv", description: "check", tool: "check_inventory", dependsOn: [] },
  { id: "qty", description: "compute", tool: "compute_reorder_qty", dependsOn: ["inv"] },
  { id: "send", description: "send", tool: "notify_supplier", dependsOn: ["qty"] },
];

describe("createPlan with a tool catalog", () => {
  it("shows the model the catalog", async () => {
    const llm = new ScriptedLlm([tasks(wired)]);

    await createPlan("restock", { llm, now, tools: catalog });

    expect(llm.requests[0]?.prompt).toContain("check_inventory (research)");
    expect(llm.requests[0]?.prompt).toContain('"tool"');
  });

  it("keeps the tool binding on each planned task", async () => {
    const result = await createPlan("restock", { llm: new ScriptedLlm([tasks(wired)]), now, tools: catalog });

    expect(result.plan.tasks.map((t) => t.tool)).toEqual(["check_inventory", "compute_reorder_qty", "notify_supplier"]);
    expect(result.attempts).toHaveLength(1);
  });

  it("repairs a plan that forgot a data dependency", async () => {
    const unwired = [
      { id: "inv", description: "check", tool: "check_inventory", dependsOn: [] },
      { id: "qty", description: "compute", tool: "compute_reorder_qty", dependsOn: [] },
      { id: "send", description: "send", tool: "notify_supplier", dependsOn: ["qty"] },
    ];
    const llm = new ScriptedLlm([tasks(unwired), tasks(wired)]);

    const result = await createPlan("restock", { llm, now, tools: catalog });

    // Caught at planning time by the same feedback loop that repairs cycles,
    // instead of surfacing as a tool failure halfway through a run.
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.errors.join(" ")).toContain("consumes inventory");
    expect(llm.requests[1]?.prompt).toContain("consumes inventory");
    // The catalog is still in front of the model on the repair attempt.
    expect(llm.requests[1]?.prompt).toContain("check_inventory (research)");
  });

  it("repairs a plan that invented a tool", async () => {
    const invented = [{ id: "a", description: "x", tool: "teleport_stock", dependsOn: [] }];
    const result = await createPlan("restock", {
      llm: new ScriptedLlm([tasks(invented), tasks(wired)]),
      now,
      tools: catalog,
    });

    expect(result.attempts[0]?.errors.join(" ")).toContain('unknown tool "teleport_stock"');
  });

  it("leaves planning untouched when no catalog is given", async () => {
    const llm = new ScriptedLlm([tasks([{ id: "a", description: "x", dependsOn: [] }])]);

    const result = await createPlan("anything", { llm, now });

    expect(result.attempts).toHaveLength(1);
    expect(llm.requests[0]?.prompt).not.toContain("Tools available");
  });
});

describe("createReplan with a tool catalog", () => {
  const plan = Plan.parse({ goal: "restock", tasks: wired, createdAt: AT, revision: 0 });
  const completed = (taskId: string): Event => ({
    type: "task_completed",
    runId: "r",
    at: AT,
    taskId,
    result: { taskId, ok: true, toolCalls: [], tokensIn: 0, tokensOut: 0 },
  });
  const failed: Event = {
    type: "task_failed",
    runId: "r",
    at: AT,
    taskId: "send",
    error: "portal down",
    attempt: 1,
    willRetry: false,
  };
  const context = {
    goal: "restock",
    plan,
    state: deriveState(plan, [completed("inv"), completed("qty"), failed]),
    failedTaskId: "send",
    error: "portal down",
  };

  const repaired = [
    { id: "inv", description: "check", tool: "check_inventory", dependsOn: [] },
    { id: "qty", description: "compute", tool: "compute_reorder_qty", dependsOn: ["inv"] },
    { id: "review", description: "queue", tool: "queue_manual_review", dependsOn: ["qty"] },
  ];

  it("accepts an alternate route bound to a catalog tool", async () => {
    const result = await createReplan(context, {
      llm: new ScriptedLlm([JSON.stringify({ reason: "portal down", tasks: repaired })]),
      now,
      tools: catalog,
    });

    expect(result.plan.tasks.at(-1)?.tool).toBe("queue_manual_review");
  });

  it("repairs an alternate route that is not wired correctly", async () => {
    const unwired = repaired.map((t) => (t.id === "review" ? { ...t, dependsOn: [] } : t));
    const llm = new ScriptedLlm([
      JSON.stringify({ reason: "x", tasks: unwired }),
      JSON.stringify({ reason: "x", tasks: repaired }),
    ]);

    const result = await createReplan(context, { llm, now, tools: catalog });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.errors.join(" ")).toContain("consumes reorder");
    expect(llm.requests[0]?.prompt).toContain("queue_manual_review (publish)");
  });
});
