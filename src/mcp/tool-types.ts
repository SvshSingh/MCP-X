/**
 * Types shared by every MCP tool.
 *
 * Split out of `tools.ts` so domain tool packs can depend on the contract
 * without importing the registry that, in turn, imports them.
 */

import { z } from "zod";

/** Coarse grouping a specialist agent will own. */
export const Capability = z.enum(["research", "compute", "publish"]);
export type Capability = z.infer<typeof Capability>;

/**
 * The MCP content payload returned by every tool.
 *
 * The index signature is required by the SDK's result type: the protocol
 * permits extra top-level fields such as `_meta` and `structuredContent`, so
 * the shape is open.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /**
   * Machine-readable output, alongside the human-readable text. This is the
   * MCP spec's own field for it, and it is what a downstream task consumes:
   * the text is for people, the structure is for the next tool.
   */
  structuredContent?: Record<string, unknown>;
}

export const textResult = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent === undefined ? {} : { structuredContent }),
});

export const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  capability: Capability;
  schema: S;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult> | ToolResult;
  /**
   * The kind of structured output this tool produces, e.g. "inventory".
   * Lets a plan be checked for data wiring before anything runs.
   */
  produces?: string;
  /**
   * Kinds of upstream output this tool cannot run without. A task bound to
   * this tool must depend *directly* on a task whose tool produces each one,
   * because that is exactly what the runtime hands the tool.
   */
  consumes?: string[];
}
