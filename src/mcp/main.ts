/** Entry point for the MCP server. Run with `npm run serve`. */

import { config as loadDotenv } from "dotenv";

import { createApp, createMcpServer, resolvePort } from "./server.js";
import { readTwitterCredentials, TOOLS, toolsByCapability } from "./tools.js";

loadDotenv();

const port = resolvePort();
const app = createApp(createMcpServer());

app.listen(port, () => {
  console.log(`MCP-X server listening on http://localhost:${port}`);
  console.log(`  SSE stream:  GET  /sse`);
  console.log(`  Messages:    POST /messages?sessionId=...`);
  console.log(`  Tools:       ${TOOLS.map((t) => t.name).join(", ")}`);

  const grouped = toolsByCapability();
  for (const [capability, names] of Object.entries(grouped)) {
    if (names.length > 0) console.log(`    ${capability}: ${names.join(", ")}`);
  }

  if (!readTwitterCredentials()) {
    console.warn(
      "  ! Twitter credentials absent - createPost will return an error rather than posting.",
    );
  }
});
