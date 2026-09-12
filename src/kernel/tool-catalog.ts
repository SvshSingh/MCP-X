/**
 * Plans that name their tools, and the runtime that executes them.
 *
 * Up to Phase 8 the orchestrator ran stubbed agents: the plan said *what* to
 * do in prose and nothing actually did it. Here a plan task may bind a
 * concrete tool, which changes three things:
 *
 *   Routing becomes exact. A task bound to `notify_supplier` goes to whichever
 *   specialist owns `notify_supplier` — no keyword guessing, and the
 *   bag-of-words tie documented in ORCHESTRATOR_PLAN.md cannot arise.
 *
 *   Data wiring is checked before anything runs. A tool that consumes
 *   "inventory" must depend directly on a task whose tool produces it; a plan
 *   that forgets the edge is rejected at planning time and repaired by the
 *   same feedback loop that repairs cycles, instead of failing mid-run.
 *
 *   Execution is deterministic. The model decides the plan; the runtime
 *   invokes each tool with its dependencies' structured output. That split is
 *   what makes a run reproducible from its fixture.
 *
 * This module holds the catalog and the plan-time wiring check; `tool-runner.ts`
 * holds execution, so the planner can validate bindings without depending on
 * the agent registry.
 *
 * Phase 9 of ORCHESTRATOR_PLAN.md.
 */

import type { ToolDefinition } from "../mcp/tool-types.js";

import type { Task } from "./schemas.js";

export interface ToolCatalogEntry {
  name: string;
  description: string;
  capability: string;
  produces?: string;
  consumes?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const catalogOf = (tools: readonly ToolDefinition<any>[]): ToolCatalogEntry[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    capability: tool.capability,
    ...(tool.produces === undefined ? {} : { produces: tool.produces }),
    ...(tool.consumes === undefined ? {} : { consumes: tool.consumes }),
  }));

/** Rendered into the planner's and replanner's prompt. */
export function renderCatalog(catalog: readonly ToolCatalogEntry[]): string {
  return [
    "Tools available. Every task MUST set \"tool\" to exactly one of these names, and a task",
    "MUST list in dependsOn a task that produces each kind of data its tool consumes:",
    "",
    ...catalog.map((tool) => {
      const io = [
        tool.consumes && tool.consumes.length > 0 ? `consumes: ${tool.consumes.join(", ")}` : null,
        tool.produces ? `produces: ${tool.produces}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      return `- ${tool.name} (${tool.capability})${io ? ` [${io}]` : ""}: ${tool.description}`;
    }),
    "",
    'Each task object therefore looks like: {"id": "...", "description": "...", "tool": "<tool name>", "agentHint": "<the tool\'s capability>", "dependsOn": ["..."]}',
  ].join("\n");
}

type BindableTask = Pick<Task, "id" | "tool" | "dependsOn">;

/**
 * Problems with a plan's tool bindings, phrased as instructions for the model.
 *
 * Checks that every task names a real tool, and that every kind of data a tool
 * consumes arrives from a *direct* dependency — direct, because that is exactly
 * what the runner hands the tool. A transitive producer two hops up would pass
 * a looser check and still leave the tool without its input at run time.
 */
export function validateToolBindings(
  tasks: readonly BindableTask[],
  catalog: readonly ToolCatalogEntry[],
): string[] {
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const names = catalog.map((tool) => tool.name).join(", ");
  const problems: string[] = [];

  for (const task of tasks) {
    if (task.tool === undefined) {
      problems.push(`task "${task.id}" has no "tool"; set it to one of: ${names}`);
      continue;
    }

    const tool = byName.get(task.tool);
    if (!tool) {
      problems.push(`task "${task.id}" uses unknown tool "${task.tool}"; use one of: ${names}`);
      continue;
    }

    for (const kind of tool.consumes ?? []) {
      const satisfied = task.dependsOn.some((dep) => {
        const upstreamTool = byId.get(dep)?.tool;
        return upstreamTool !== undefined && byName.get(upstreamTool)?.produces === kind;
      });

      if (!satisfied) {
        const producers = catalog.filter((t) => t.produces === kind).map((t) => t.name);
        problems.push(
          `task "${task.id}" (${task.tool}) consumes ${kind} but does not depend directly on a task using ${
            producers.join(" or ") || `a tool that produces ${kind}`
          }; add that task's id to its dependsOn`,
        );
      }
    }
  }

  return problems;
}

