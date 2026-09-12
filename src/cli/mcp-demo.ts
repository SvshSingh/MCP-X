/**
 * Shows that the orchestrator's tools are ordinary MCP tools any client can use.
 *
 *   npm run mcp:demo
 *
 * Starts the MCP server on a free local port, connects a real MCP SDK client
 * over SSE, lists the tools, then drives the supply-chain workflow by hand —
 * each call's structured output passed as the next call's `upstream` — so the
 * data flow the orchestrator automates is visible step by step. One command,
 * one terminal; the server stops when it finishes.
 */

import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { createApp, createMcpServer } from "../mcp/server.js";

type CallResult = { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function main(): Promise<number> {
  const server = createApp(createMcpServer()).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/sse`;

  const client = new Client({ name: "mcp-x-demo-client", version: "1.0.0" });

  try {
    await client.connect(new SSEClientTransport(new URL(url)));
    console.log(`Connected an MCP client to ${url}\n`);

    const { tools } = await client.listTools();
    console.log(`Server exposes ${tools.length} tools:`);
    for (const tool of tools) console.log(`  - ${tool.name.padEnd(22)} ${tool.description ?? ""}`);

    const call = async (name: string, upstream: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: { upstream, runId: "mcp-demo" } })) as CallResult;
      console.log(`\n> ${name}`);
      console.log(`  ${result.isError ? "ERROR: " : ""}${result.content[0]?.text ?? ""}`);
      return result.structuredContent;
    };

    console.log("\nDriving the workflow by hand over MCP:");
    const inventory = await call("check_inventory");
    const suppliers = await call("lookup_suppliers", { inventory });
    const reorder = await call("compute_reorder_qty", { inventory });
    const compliance = await call("validate_compliance", { reorder, suppliers });
    await call("notify_supplier", { compliance });

    console.log("\nThe orchestrator does exactly this, except the model decides the order and");
    console.log("the runtime wires each tool's output into the next: npm run demo");
    return 0;
  } finally {
    await client.close().catch(() => undefined);
    server.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
    // SSE keeps sockets open briefly after close; exit explicitly.
    setTimeout(() => process.exit(code), 50);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
