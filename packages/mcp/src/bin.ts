#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadEnv, localAddresses, parseAllow, tokenFromEnv, type Cidr } from "@mockdata/cli";
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

Machines other than this one must send "Authorization: Bearer <token>": set MOCKDATA_TOKEN
(16+ characters, in the environment or .env) or one is generated and printed at start.
Anyone holding the token can use every tool (read and write files under the root, spend LLM
credits). Traffic is plain http, so use a network you trust (for example a Tailscale tailnet).

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
      const token = allow ? tokenFromEnv(loadEnv(root, process.env)) : undefined;
      const { url, server, token: active, tokenGenerated } = await startMcpHttp({ root, port, allow, host: values.host, token });
      process.stderr.write(`mockdata-mcp on ${url}/mcp (root: ${root})\n`);
      if (allow) {
        const listening = (server.address() as { port: number }).port;
        process.stderr.write(`Also open to ${allow.map((c) => c.text).join(", ")}: ${localAddresses().map((a) => `http://${a}:${listening}/mcp`).join("  ")}\n`);
        process.stderr.write(`${tokenGenerated ? `Generated token (set MOCKDATA_TOKEN to keep one): ${active}` : "Token: from MOCKDATA_TOKEN"}\n`);
        process.stderr.write("Clients send: Authorization: Bearer <token>. Plain http: use a network you trust.\n");
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
