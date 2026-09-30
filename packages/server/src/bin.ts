#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadEnv, localAddresses, parseAllow, tokenFromEnv, type Cidr } from "@mockdata/cli";
import { startServer } from "./listen.js";

const HELP = `mockdata-ui - local web UI for mockdata

Usage:
  mockdata-ui [root] [--port <n>] [--allow <ranges>] [--host <address>]

  root            folder holding your schema files and .env (default: current directory)
  --port <n>      port (default 4747)
  --allow <list>  also serve these private ranges, comma separated: 100.100.1.x (a /24),
                  a CIDR such as 192.168.0.0/16, or a single IP. Only 10/8, 172.16/12,
                  192.168/16 and 100.64/10 are accepted, at most a /16 wide. Without
                  --allow the UI answers on 127.0.0.1 only.
  --host <addr>   address to bind (default 127.0.0.1, or 0.0.0.0 with --allow)
  -h, --help

Machines other than this one must present a shared secret: set MOCKDATA_TOKEN (16+ characters,
in the environment or .env) or one is generated and printed at start. Open the UI once with
http://<address>:<port>/?token=<token> (it sets a cookie); scripts send "Authorization: Bearer <token>".
Anyone holding the token can read and write schema files under root and use your LLM keys.
Traffic is plain http, so use a network you trust (for example a Tailscale tailnet).
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, allow: { type: "string" }, host: { type: "string" }, help: { type: "boolean", short: "h" } },
});

if (values.help) {
  process.stdout.write(HELP);
} else if (positionals.length > 1) {
  process.stderr.write(`Expected at most one folder\n\n${HELP}`);
  process.exitCode = 1;
} else {
  const port = values.port === undefined ? 4747 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid --port "${values.port}"\n`);
    process.exitCode = 1;
  } else {
    try {
      const root = positionals[0] ?? process.cwd();
      const allow: Cidr[] | undefined = values.allow === undefined ? undefined : parseAllow(values.allow);
      const token = allow ? tokenFromEnv(loadEnv(root, process.env)) : undefined;
      const { url, server, token: active, tokenGenerated } = await startServer({ root, port, allow, host: values.host, token });
      const listening = (server.address() as { port: number }).port;
      process.stdout.write(`mockdata UI on ${url}  (root: ${root})\n`);
      if (allow) {
        process.stdout.write(`Also open to ${allow.map((c) => c.text).join(", ")}: ${localAddresses().map((a) => `http://${a}:${listening}`).join("  ")}\n`);
        const shown = tokenGenerated ? active : "<your MOCKDATA_TOKEN>";
        process.stdout.write(`${tokenGenerated ? "Generated token (set MOCKDATA_TOKEN to keep one): " : "Token: from MOCKDATA_TOKEN. "}${tokenGenerated ? active : ""}\n`);
        process.stdout.write(`Open once from another machine: http://<address>:${listening}/?token=${shown}\n`);
        process.stdout.write("Plain http: use a network you trust.\n");
      }
      process.stdout.write("Press Ctrl+C to stop.\n");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      process.stderr.write(err.code === "EADDRINUSE" ? `Port ${values.port ?? 4747} is already in use (try --port)\n` : `${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
