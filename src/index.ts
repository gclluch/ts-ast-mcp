#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./register.js";

// Read package.json rather than restating the number here. A literal drifts the
// moment `npm version` bumps package.json and leaves this untouched, and the
// value is what every MCP client displays as the server's version. The Python
// sibling shipped a release reporting the previous version for exactly this
// reason.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({
  name: "ts-ast-mcp",
  version,
});

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
