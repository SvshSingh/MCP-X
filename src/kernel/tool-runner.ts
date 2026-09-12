/**
 * Executes plan tasks by invoking their bound tools through the specialist
 * that owns them. See `tool-catalog.ts` for why plans bind tools at all.
 *
 * Phase 9 of ORCHESTRATOR_PLAN.md.
 */

import { buildSpecialists, type AgentRegistry } from "../agents/registry.js";
import type { ToolDefinition } from "../mcp/tool-types.js";

import { keywordClassify } from "./classifier.js";
import type { AgentRunner, Classifier } from "./orchestrator.js";
import type { AgentResultInput, Task } from "./schemas.js";

/**
 * Routes a bound task to the specialist that owns its tool, falling back to
 * keyword routing for a task with no tool.
 *
 * Ownership is authoritative rather than a hint: if the planner's agentHint and
 * the owner disagree, the owner wins, because the owner is the only specialist
 * that *can* run the tool.
 */
export const toolOwnerClassifier =
  (registry: AgentRegistry): Classifier =>
  (task) => {
    if (task.tool !== undefined) {
      const owner = registry.ownerOf(task.tool);
      if (owner) return owner.name;
    }
    return keywordClassify(task, registry).agent;
  };

export interface ToolRunnerOptions {
  registry: AgentRegistry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: readonly ToolDefinition<any>[];
  /** Observes each completed tool call; the demo uses it to narrate. */
  onToolCall?: (event: { task: Task; tool: string; ok: boolean; text: string; durationMs: number }) => void;
}

/**
 * Executes a task by invoking its bound tool through the routed specialist.
 *
 * Every failure mode becomes an ordinary failed result the orchestrator
 * already knows how to handle — retry, block the subtree, replan — rather than
 * a thrown error: no tool bound, a specialist asked for a tool it does not own,
 * invalid arguments, and a tool reporting `isError`.
 */
export function createToolRunner(options: ToolRunnerOptions): AgentRunner {
  const specialists = buildSpecialists(options.registry, options.tools);

  return async (task, ctx): Promise<AgentResultInput> => {
    if (task.tool === undefined) {
      return { taskId: task.id, ok: false, error: `Task "${task.id}" has no tool bound` };
    }

    const specialist = specialists.get(ctx.agent);
    if (!specialist) {
      return { taskId: task.id, ok: false, error: `No specialist registered as "${ctx.agent}"` };
    }

    const upstream = Object.fromEntries(
      task.dependsOn
        .map((dep) => [dep, ctx.state.tasks.get(dep)?.result?.data] as const)
        .filter(([, data]) => data !== undefined),
    );

    const args = { ...(task.args ?? {}), upstream, runId: ctx.runId };
    const started = Date.now();

    try {
      const result = await specialist.invoke(task.tool, args);
      const durationMs = Date.now() - started;
      const text = result.content.map((part) => part.text).join("\n");
      const ok = result.isError !== true;

      options.onToolCall?.({ task, tool: task.tool, ok, text, durationMs });

      const toolCall = {
        tool: task.tool,
        // The upstream payload can be large and is already in the record as
        // the dependencies' own results; recording its keys is enough to show
        // what the tool was given without duplicating it.
        args: { ...(task.args ?? {}), upstream: Object.keys(upstream) },
        ok,
        durationMs,
        ...(ok ? {} : { error: text }),
      };

      return ok
        ? {
            taskId: task.id,
            ok: true,
            output: text,
            ...(result.structuredContent === undefined ? {} : { data: result.structuredContent }),
            toolCalls: [toolCall],
          }
        : { taskId: task.id, ok: false, error: text || `${task.tool} failed`, toolCalls: [toolCall] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - started;
      options.onToolCall?.({ task, tool: task.tool, ok: false, text: message, durationMs });
      return {
        taskId: task.id,
        ok: false,
        error: message || `${task.tool} threw`,
        toolCalls: [{ tool: task.tool, args: {}, ok: false, durationMs, error: message }],
      };
    }
  };
}
