/**
 * The supply-chain tools over the actual MCP transport, with a real SDK client.
 *
 * Unit tests call handlers directly; this proves the same tools are reachable
 * by any MCP client — listing, argument validation, text content and
 * `structuredContent` all survive the SSE round trip.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { createApp, createMcpServer } from "../../src/mcp/server.js";

let server: Server;
let client: Client;

beforeAll(async () => {
  server = createApp(createMcpServer()).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)));
});

afterAll(async () => {
  await client.close();
  await new Promise((resolve) => server.close(resolve));
});

describe("MCP server over SSE", () => {
  it("lists the supply-chain tools alongside the original ones", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const name of ["check_inventory", "compute_reorder_qty", "validate_compliance", "notify_supplier"]) {
      expect(names, name).toContain(name);
    }
    expect(names).toContain("addTwoNumbers");
  });

  it("returns text and structuredContent from a real tool call", async () => {
    const result = await client.callTool({ name: "check_inventory", arguments: {} });
    const text = (result.content as { text: string }[])[0]?.text;

    expect(text).toContain("6 of 8 SKUs");
    expect((result.structuredContent as { kind?: string }).kind).toBe("inventory");
  });

  it("reports a missing upstream as a tool error, not a transport failure", async () => {
    const result = await client.callTool({ name: "compute_reorder_qty", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain("dependsOn");
  });

  it("still serves the original demo tool", async () => {
    const result = await client.callTool({ name: "addTwoNumbers", arguments: { a: 2, b: 3 } });

    expect((result.content as { text: string }[])[0]?.text).toBe("The sum of 2 and 3 is 5");
  });
});
