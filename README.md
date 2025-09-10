<h1 align="center">MCP-X</h1>

<p align="center">
  <strong>Minimal example of a Model Context Protocol (MCP) server + client</strong><br/>
  Lightweight demo showing how to wire an MCP server and a simple client, integrate a Google GenAI tool, and expose a sample Twitter posting tool.
</p>

---

[![](https://img.shields.io/badge/Node.js-16%2B-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![](https://img.shields.io/badge/Made_with-ModelContextProtocol-green?style=for-the-badge&logo=github)](https://github.com/model-context-protocol)
[![](https://img.shields.io/badge/Made_with-Express-green?style=for-the-badge&logo=express)](https://expressjs.com/)
[![](https://img.shields.io/badge/Made_with-Google_GenAI-green?style=for-the-badge&logo=google)](https://cloud.google.com/ai)

---

## About

**MCP-X** is a compact example project that demonstrates how to:

- Run a small MCP (Model Context Protocol) server (using `@modelcontextprotocol/sdk`).
- Build a minimal client that connects to an LLM provider (Google GenAI in this demo).
- Add custom tools (a Twitter post tool is included as an example).
- Expose server <> client messaging over SSE (server-sent events).

This repo is intended as a starter template for experimenting with model-context tooling and simple tool integrations.

---

## Key Features

- MCP server setup using `@modelcontextprotocol/sdk`.
- Minimal client demo that uses Google GenAI for responses.
- Example tool: `createPost` — posts tweets using `twitter-api-v2` (demo tool).
- SSE transport wiring between client and server.
- Basic Express endpoints to relay messages.

---

## Tech Stack

- **Runtime:** Node.js (ESM modules)
- **Framework:** Express
- **MCP SDK:** @modelcontextprotocol/sdk
- **LLM Provider:** Google GenAI (`@google/genai`)
- **Example API Tool:** twitter-api-v2
- **Config:** dotenv

---

## Project Structure

```
MCP-X-main/
├─ client/
│  ├─ index.js          # minimal client demo (Google GenAI + MCP client)
│  ├─ package.json
│  └─ package-lock.json
├─ server/
│  ├─ index.js          # MCP server + Express endpoints
│  ├─ mcp.tool.js       # example tool (Twitter post)
│  ├─ package.json
│  └─ package-lock.json
└─ .gitignore
```

---

## Setup & Quickstart

**Requirements:** Node.js 16+ and npm

1. **Clone the repo**
   ```bash
   git clone <your-repo-url>
   cd MCP-X-main
   ```

2. **Install dependencies**
   ```bash
   # Server
   cd server
   npm install

   # Client (in another terminal)
   cd ../client
   npm install
   ```

3. **Create `.env` files** in both `server/` and `client/`

Example `.env` files:

**client/.env**
```
GEMINI_API_KEY=your_google_gemini_api_key
MCP_SERVER_URL=http://localhost:3000
```

**server/.env**
```
PORT=3000
TWITTER_API_KEY=your_twitter_api_key
TWITTER_API_SECRET=your_twitter_api_secret
TWITTER_ACCESS_TOKEN=your_twitter_access_token
TWITTER_ACCESS_TOKEN_SECRET=your_twitter_access_token_secret
```

4. **Run the server**
   ```bash
   cd server
   node index.js
   ```

5. **Run the client**
   ```bash
   cd client
   node index.js
   ```

--- 

## How It Works

- The server starts an MCP server instance and registers tools from `mcp.tool.js`.
- Tools can call external APIs (Twitter API in the example).
- The client connects to the MCP server, sends prompts to Google GenAI, and can invoke registered tools.
- Server and client communicate via HTTP and SSE.

--- 

## Extending the Project

- Add more tools: integrate Gmail, Slack, or custom APIs.
- Replace Google GenAI with OpenAI, Anthropic, or any LLM provider.
- Add authentication for secure tool access.
- Create a frontend UI to visualize and trigger tool actions.

--- 

## Security

- Never commit `.env` or API keys — `.gitignore` already excludes `.env` and `node_modules`.
- Validate all inputs to tools.
- For posting APIs (like Twitter), add confirmation flows to avoid accidental posts.

--- 

## Contributing

1. Fork the repo.
2. Create a feature branch.
3. Commit your changes.
4. Open a Pull Request.

