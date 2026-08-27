/**
 * MCP tool definitions.
 *
 * Ported from `server/index.js` and `server/mcp.tool.js`, with one structural
 * change: tools are declared as data in a single registry rather than being
 * registered inline against the server. Phase 4 needs to partition this list
 * across specialist agents, which is impossible when each tool exists only as
 * a side effect of a `server.tool(...)` call at startup.
 *
 * Each tool also declares a `capability`, which is the seam the classifier
 * routes on.
 */

import { z } from "zod";

import { TwitterApi } from "twitter-api-v2";

/** Coarse grouping a specialist agent will own. */
export const Capability = z.enum(["research", "compute", "publish"]);
export type Capability = z.infer<typeof Capability>;

/**
 * The MCP content payload returned by every tool.
 *
 * The index signature is required by the SDK's result type: the protocol
 * permits extra top-level fields such as `_meta`, so the shape is open.
 */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
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
}

/* -------------------------------------------------------------------------- */
/* addTwoNumbers                                                              */
/* -------------------------------------------------------------------------- */

export const addTwoNumbers: ToolDefinition<{ a: z.ZodNumber; b: z.ZodNumber }> = {
  name: "addTwoNumbers",
  description: "Add two numbers and return the sum.",
  capability: "compute",
  schema: { a: z.number(), b: z.number() },
  handler: ({ a, b }) => textResult(`The sum of ${a} and ${b} is ${a + b}`),
};

/* -------------------------------------------------------------------------- */
/* createPost                                                                 */
/* -------------------------------------------------------------------------- */

export interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

/**
 * Reads Twitter credentials, returning null when any are missing.
 *
 * The original module built a `TwitterApi` at import time from whatever was in
 * the environment, so importing the tools at all required credentials to exist
 * and a missing key surfaced as a confusing failure at call time. Now the
 * absence is detected up front and reported as a normal tool error, which the
 * orchestrator can route around.
 */
export function readTwitterCredentials(
  env: NodeJS.ProcessEnv = process.env,
): TwitterCredentials | null {
  const appKey = env["TWITTER_API_KEY"];
  const appSecret = env["TWITTER_API_SECRET"];
  const accessToken = env["TWITTER_ACCESS_TOKEN"];
  const accessSecret = env["TWITTER_ACCESS_TOKEN_SECRET"];

  if (!appKey || !appSecret || !accessToken || !accessSecret) return null;

  return { appKey, appSecret, accessToken, accessSecret };
}

export const TWEET_MAX_LENGTH = 280;

export interface CreatePostOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable so tests never touch the network. */
  post?: (status: string, credentials: TwitterCredentials) => Promise<void>;
}

const realPost = async (status: string, credentials: TwitterCredentials): Promise<void> => {
  await new TwitterApi(credentials).v2.tweet(status);
};

export function makeCreatePost(
  options: CreatePostOptions = {},
): ToolDefinition<{ status: z.ZodString }> {
  const post = options.post ?? realPost;

  return {
    name: "createPost",
    description: "Post a status to X (formerly Twitter).",
    capability: "publish",
    schema: { status: z.string().min(1) },
    handler: async ({ status }) => {
      if (status.length > TWEET_MAX_LENGTH) {
        return errorResult(
          `Status is ${status.length} characters; the limit is ${TWEET_MAX_LENGTH}.`,
        );
      }

      const credentials = readTwitterCredentials(options.env ?? process.env);
      if (!credentials) {
        return errorResult(
          "Twitter credentials are not configured. Set TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN and TWITTER_ACCESS_TOKEN_SECRET.",
        );
      }

      try {
        await post(status, credentials);
        return textResult(`Tweeted: ${status}`);
      } catch (error) {
        return errorResult(
          `Failed to post: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export const createPost = makeCreatePost();

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOLS: ToolDefinition<any>[] = [addTwoNumbers, createPost];

export const toolsByCapability = (
  tools: readonly ToolDefinition<z.ZodRawShape>[] = TOOLS,
): Record<Capability, string[]> => {
  const grouped: Record<Capability, string[]> = { research: [], compute: [], publish: [] };
  for (const tool of tools) grouped[tool.capability].push(tool.name);
  return grouped;
};
