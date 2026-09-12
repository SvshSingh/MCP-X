import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentDefinition, AgentRegistry, defaultRegistry } from "../../src/agents/registry.js";
import { makeSupplyChainTools } from "../../src/domain/supply-chain/tools.js";
import { deriveState } from "../../src/kernel/blackboard.js";
import { catalogOf, renderCatalog, validateToolBindings } from "../../src/kernel/tool-catalog.js";
import { createToolRunner, toolOwnerClassifier } from "../../src/kernel/tool-runner.js";
import { Plan, type Event, type Task } from "../../src/kernel/schemas.js";
import { textResult, errorResult } from "../../src/mcp/tool-types.js";
import type { ToolDefinition } from "../../src/mcp/tool-types.js";

const catalog = catalogOf(makeSupplyChainTools());
const registry = defaultRegistry();
const AT = "2026-09-13T10:00:00.000Z";

const t = (id: string, tool: string | undefined, dependsOn: string[] = []) => ({
  id,
  ...(tool === undefined ? {} : { tool }),
  dependsOn,
});

const task = (over: Partial<Task> & { id: string }): Task => ({
  description: `do ${over.id}`,
  dependsOn: [],
  status: "pending",
  attempts: 0,
  ...over,
});

/* -------------------------------------------------------------------------- */

describe("renderCatalog", () => {
  it("lists every tool with its capability and data wiring", () => {
    const text = renderCatalog(catalog);

    expect(text).toContain("check_inventory (research) [produces: inventory]");
    expect(text).toContain("notify_supplier (publish) [consumes: compliance; produces: notification]");
    expect(text).toContain('"tool"');
  });
});

describe("validateToolBindings", () => {
  const valid = [
    t("inv", "check_inventory"),
    t("sup", "lookup_suppliers", ["inv"]),
    t("qty", "compute_reorder_qty", ["inv"]),
    t("chk", "validate_compliance", ["qty", "sup"]),
    t("send", "notify_supplier", ["chk"]),
  ];

  it("accepts a correctly wired plan", () => {
    expect(validateToolBindings(valid, catalog)).toEqual([]);
  });

  it("requires every task to name a tool", () => {
    const problems = validateToolBindings([t("inv", undefined)], catalog);

    expect(problems[0]).toContain('task "inv" has no "tool"');
    expect(problems[0]).toContain("check_inventory");
  });

  it("rejects a tool that is not in the catalog", () => {
    expect(validateToolBindings([t("x", "teleport")], catalog)[0]).toContain('unknown tool "teleport"');
  });

  it("rejects a consumer with no producer upstream, naming the fix", () => {
    const problems = validateToolBindings([t("inv", "check_inventory"), t("qty", "compute_reorder_qty")], catalog);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("consumes inventory");
    expect(problems[0]).toContain("check_inventory");
    expect(problems[0]).toContain("dependsOn");
  });

  it("requires the producer as a DIRECT dependency, not merely an ancestor", () => {
    // qty is two hops from inventory through sup. The runtime hands a tool only
    // its direct dependencies' output, so a transitive producer would pass a
    // looser check and still leave the tool without its input.
    const problems = validateToolBindings(
      [t("inv", "check_inventory"), t("sup", "lookup_suppliers", ["inv"]), t("qty", "compute_reorder_qty", ["sup"])],
      catalog,
    );

    expect(problems.some((p) => p.includes('"qty"'))).toBe(true);
  });

  it("does not demand data a tool does not consume", () => {
    expect(validateToolBindings([t("inv", "check_inventory")], catalog)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("toolOwnerClassifier", () => {
  const classify = toolOwnerClassifier(registry);

  it("routes a bound task to the specialist that owns its tool", () => {
    expect(classify(task({ id: "a", tool: "notify_supplier" }))).toBe("publish");
    expect(classify(task({ id: "b", tool: "check_inventory" }))).toBe("research");
    expect(classify(task({ id: "c", tool: "validate_compliance" }))).toBe("compute");
  });

  it("lets ownership override a contradicting agent hint", () => {
    // The owner is the only specialist that CAN run the tool.
    expect(classify(task({ id: "a", tool: "notify_supplier", agentHint: "research" }))).toBe("publish");
  });

  it("resolves the case keyword routing could not", () => {
    // "Format ... and publish" ties compute against publish on keywords; a
    // bound tool makes the question moot.
    const tie = task({
      id: "publish_newsletter",
      description: "Format the summaries into a newsletter and publish it",
      tool: "queue_manual_review",
    });
    expect(classify(tie)).toBe("publish");
  });

  it("falls back to keyword routing for an unbound task", () => {
    expect(classify(task({ id: "x", description: "Fetch the front page" }))).toBe("research");
  });

  it("falls back to keywords for a tool no agent owns", () => {
    expect(classify(task({ id: "x", description: "Calculate totals", tool: "unowned_tool" }))).toBe("compute");
  });
});

/* -------------------------------------------------------------------------- */

describe("createToolRunner", () => {
  const plan = Plan.parse({
    goal: "g",
    tasks: [
      { id: "src", description: "produce", tool: "produce" },
      { id: "dst", description: "consume", tool: "consume", dependsOn: ["src"] },
    ],
    createdAt: AT,
    revision: 0,
  });

  const produce: ToolDefinition = {
    name: "produce",
    description: "produces a value",
    capability: "research",
    schema: {},
    handler: () => textResult("produced 42", { kind: "number", value: 42 }),
  };
  const seen = vi.fn();
  const consume: ToolDefinition = {
    name: "consume",
    description: "consumes a value",
    capability: "compute",
    // A consuming tool must declare the runtime arguments: the specialist
    // validates through this schema, and Zod strips anything undeclared.
    schema: { upstream: z.record(z.unknown()).optional(), runId: z.string().optional() },
    handler: (args) => {
      seen(args);
      return textResult("consumed");
    },
  };
  const broken: ToolDefinition = {
    name: "broken",
    description: "always errors",
    capability: "compute",
    schema: {},
    handler: () => errorResult("portal unreachable"),
  };

  const testRegistry = new AgentRegistry([
    AgentDefinition.parse({ name: "research", description: "reads", capability: "research", tools: ["produce"] }),
    AgentDefinition.parse({ name: "compute", description: "computes", capability: "compute", tools: ["consume", "broken"] }),
  ]);
  const runner = createToolRunner({ registry: testRegistry, tools: [produce, consume, broken] });

  const completed = (taskId: string, data: unknown): Event => ({
    type: "task_completed",
    runId: "run-1",
    at: AT,
    taskId,
    result: { taskId, ok: true, output: "ok", data, toolCalls: [], tokensIn: 0, tokensOut: 0 },
  });

  it("returns the tool's structured output as the result's data", async () => {
    const result = await runner(plan.tasks[0]!, {
      attempt: 1,
      agent: "research",
      state: deriveState(plan, []),
      runId: "run-1",
    });

    expect(result).toMatchObject({ ok: true, output: "produced 42", data: { kind: "number", value: 42 } });
    expect(result.toolCalls?.[0]).toMatchObject({ tool: "produce", ok: true });
  });

  it("hands a tool its direct dependencies' data, keyed by task id, plus the run id", async () => {
    seen.mockClear();
    const state = deriveState(plan, [completed("src", { kind: "number", value: 42 })]);

    await runner(plan.tasks[1]!, { attempt: 1, agent: "compute", state, runId: "run-9" });

    expect(seen).toHaveBeenCalledWith({ upstream: { src: { kind: "number", value: 42 } }, runId: "run-9" });
  });

  it("strips upstream from a tool whose schema does not declare it", async () => {
    const undeclared = vi.fn();
    const blind: ToolDefinition = {
      name: "consume",
      description: "declares no args",
      capability: "compute",
      schema: {},
      handler: (args) => {
        undeclared(args);
        return textResult("ok");
      },
    };
    const r = createToolRunner({ registry: testRegistry, tools: [produce, blind] });
    const state = deriveState(plan, [completed("src", { kind: "number", value: 42 })]);

    await r(plan.tasks[1]!, { attempt: 1, agent: "compute", state, runId: "r" });

    // Arguments pass through the tool's own schema, so undeclared keys never
    // reach the handler. Pinned here because it is the first thing someone
    // writing a new consuming tool will trip over.
    expect(undeclared).toHaveBeenCalledWith({});
  });

  it("records upstream keys rather than duplicating upstream payloads", async () => {
    const state = deriveState(plan, [completed("src", { kind: "number", value: 42 })]);

    const result = await runner(plan.tasks[1]!, { attempt: 1, agent: "compute", state, runId: "r" });

    expect(result.toolCalls?.[0]?.args).toEqual({ upstream: ["src"] });
  });

  it("fails a task with no tool bound", async () => {
    const result = await runner(task({ id: "loose" }), {
      attempt: 1,
      agent: "compute",
      state: deriveState(plan, []),
      runId: "r",
    });

    expect(result).toMatchObject({ ok: false, error: 'Task "loose" has no tool bound' });
  });

  it("fails when routed to a specialist that does not exist", async () => {
    const result = await runner(plan.tasks[0]!, { attempt: 1, agent: "ghost", state: deriveState(plan, []), runId: "r" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ghost");
  });

  it("enforces ownership: a specialist cannot run a tool it does not own", async () => {
    // `produce` belongs to research; routing it to compute must fail rather
    // than quietly run, or the boundary would be decoration.
    const result = await runner(plan.tasks[0]!, { attempt: 1, agent: "compute", state: deriveState(plan, []), runId: "r" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('may not use tool "produce"');
  });

  it("turns a tool's isError into a failed result the orchestrator can replan around", async () => {
    const onToolCall = vi.fn();
    const r = createToolRunner({ registry: testRegistry, tools: [produce, consume, broken], onToolCall });

    const result = await r(task({ id: "b", tool: "broken" }), {
      attempt: 1,
      agent: "compute",
      state: deriveState(plan, []),
      runId: "r",
    });

    expect(result).toMatchObject({ ok: false, error: "portal unreachable" });
    expect(result.toolCalls?.[0]).toMatchObject({ ok: false, error: "portal unreachable" });
    expect(onToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "broken", ok: false }));
  });

  it("turns a thrown tool error into a failed result", async () => {
    const throwing: ToolDefinition = {
      name: "consume",
      description: "throws",
      capability: "compute",
      schema: {},
      handler: () => {
        throw new Error("kaboom");
      },
    };
    const r = createToolRunner({ registry: testRegistry, tools: [produce, throwing] });

    const result = await r(plan.tasks[1]!, { attempt: 1, agent: "compute", state: deriveState(plan, []), runId: "r" });

    expect(result).toMatchObject({ ok: false, error: "kaboom" });
  });
});
