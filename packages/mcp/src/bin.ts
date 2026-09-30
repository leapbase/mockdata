#!/usr/bin/env node
import { parseArgs } from "node:util";
import { localAddresses, parseAllow, type Cidr } from "@mockdata/cli";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startMcpHttp } from "./http.js";
import { createServer } from "./server.js";

const HELP = `mockdata-mcp - MCP server for mockdata

Usage:
  mockdata-mcp                 stdio (the client starts this process)
  mockdata-mcp --http [--port <n>] [--allow <ranges>] [--host <address>]
                               Streamable HTTP at http://127.0.0.1:<n>/mcp (default port 4748),
                               localhost only unless --allow is given
  --allow <list>               also serve these private ranges, comma separated: 100.100.1.x
                               (a /24), a CIDR such as 192.168.0.0/16, or a single IP. Only
                               10/8, 172.16/12, 192.168/16 and 100.64/10 are accepted, at
                               most a /16 wide.
  --host <addr>                address to bind (default 127.0.0.1, or 0.0.0.0 with --allow)

There is no login: anyone in an allowed range can use every tool (read and write files under
the root, spend LLM credits). Only allow networks you trust.

Both read MOCKDATA_ROOT (default: current directory): schemas and output stay inside it.
`;

// In stdio mode stdout carries the MCP protocol: log to stderr only.
const { values } = parseArgs({
  options: { http: { type: "boolean" }, port: { type: "string" }, allow: { type: "string" }, host: { type: "string" }, help: { type: "boolean", short: "h" } },
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
      const allow: Cidr[] | undefined = values.allow === undefined ? undefined : parseAllow(values.allow);
      const { url, server } = await startMcpHttp({ root, port, allow, host: values.host });
      process.stderr.write(`mockdata-mcp on ${url}/mcp (root: ${root})\n`);
      if (allow) {
        const listening = (server.address() as { port: number }).port;
        process.stderr.write(`Also open to ${allow.map((c) => c.text).join(", ")}: ${localAddresses().map((a) => `http://${a}:${listening}/mcp`).join("  ")}\n`);
        process.stderr.write("There is no login. Only allow networks you trust.\n");
      }
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
