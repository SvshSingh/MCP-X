/**
 * MCP server over SSE.
 *
 * A direct port of `server/index.js`. Behaviour is unchanged apart from three
 * fixes the original could not survive in an orchestrator:
 *
 * - the port is configurable rather than hard-coded to 3001;
 * - tools come from the registry in `tools.ts` instead of being registered
 *   inline, so Phase 4 can hand subsets to different specialists;
 * - a POST for an unknown session returns a JSON error instead of bare text,
 *   and transports are cleaned up on error as well as on close.
 */

import express, { type Express } from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { TOOLS, type ToolDefinition } from "./tools.js";

export const DEFAULT_PORT = 3001;

export interface McpServerOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: ToolDefinition<any>[];
  name?: string;
  version?: string;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? "mcp-x",
    version: options.version ?? "0.1.0",
  });

  for (const tool of options.tools ?? TOOLS) {
    server.tool(tool.name, tool.description, tool.schema, async (args: unknown) =>
      tool.handler(args as never),
    );
  }

  return server;
}

export function createApp(server: McpServer): Express {
  const app = express();

  // sessionId -> transport, so concurrent clients each keep their own stream.
  const transports = new Map<string, SSEServerTransport>();

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: transports.size });
  });

  app.get("/sse", async (_req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    const drop = (): void => {
      transports.delete(transport.sessionId);
    };

    res.on("close", drop);
    // The original only handled "close"; an errored stream leaked its entry.
    res.on("error", drop);

    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query["sessionId"];

    if (typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId query parameter is required" });
      return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: `No active session for sessionId "${sessionId}"` });
      return;
    }

    await transport.handlePostMessage(req, res);
  });

  return app;
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["MCP_PORT"] ?? env["PORT"];
  if (raw === undefined) return DEFAULT_PORT;

  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}
