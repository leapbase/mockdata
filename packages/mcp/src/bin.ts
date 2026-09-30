#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startMcpHttp } from "./http.js";
import { createServer } from "./server.js";

const HELP = `mockdata-mcp - MCP server for mockdata

Usage:
  mockdata-mcp                 stdio (the client starts this process)
  mockdata-mcp --http [--port <n>]
                               Streamable HTTP at http://127.0.0.1:<n>/mcp (default port 4748),
                               localhost only

Both read MOCKDATA_ROOT (default: current directory): schemas and output stay inside it.
`;

// In stdio mode stdout carries the MCP protocol: log to stderr only.
const { values } = parseArgs({
  options: { http: { type: "boolean" }, port: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const root = process.env.MOCKDATA_ROOT ?? process.cwd();

if (values.help) {
  process.stdout.write(HELP);
} else if (values.http) {
  const port = values.port === undefined ? 4748 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid --port "${values.port}"\n`);
    process.exitCode = 1;
  } else {
    try {
      const { url } = await startMcpHttp({ root, port });
      process.stderr.write(`mockdata-mcp on ${url}/mcp (root: ${root})\n`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      process.stderr.write(err.code === "EADDRINUSE" ? `Port ${port} is already in use (try --port)\n` : `${err.message}\n`);
      process.exitCode = 1;
    }
  }
} else {
  await createServer({ root }).connect(new StdioServerTransport());
  process.stderr.write(`mockdata-mcp ready (root: ${root})\n`);
}
