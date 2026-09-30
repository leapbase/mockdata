#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol: log to stderr only.
const root = process.env.MOCKDATA_ROOT ?? process.cwd();
await createServer({ root }).connect(new StdioServerTransport());
process.stderr.write(`mockdata-mcp ready (root: ${root})\n`);
