#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadEnv, localAddresses, parseAllow, tokenFromEnv, type Cidr } from "@mockdata/cli";
import { poolSettingsFromEnv } from "./workers/factory.js";
import { startServer } from "./listen.js";

const HELP = `mockdata-ui - local web UI for mockdata

Usage:
  mockdata-ui [root] [--port <n>] [--allow <ranges>] [--host <address>]

  root            folder holding your schema files and .env (default: current directory)
  --port <n>      port (default 8000)
  --allow <list>  also serve these private ranges, comma separated: 100.100.1.x (a /24),
                  a CIDR such as 192.168.0.0/16, or a single IP. Only 10/8, 172.16/12,
                  192.168/16 and 100.64/10 are accepted, at most a /16 wide. Without
                  --allow the UI answers on 127.0.0.1 only.
  --host <addr>   address to bind (default 127.0.0.1, or 0.0.0.0 with --allow)
  -h, --help

Generation runs in worker threads so a big run does not freeze the page for everyone: MOCKDATA_WORKERS
(threads; default up to 4, 0 = run on the main thread), MOCKDATA_WORKER_QUEUE (waiting jobs, 16),
MOCKDATA_JOB_TIMEOUT_SECS (120) and MOCKDATA_WORKER_HEAP_MB (2048) in the environment or .env.

Machines other than this one must present a shared secret: set MOCKDATA_TOKEN (16+ characters,
in the environment or .env) or one is generated and printed at start. Open the UI once with
http://<address>:<port>/app?token=<token> (it sets a cookie); scripts send "Authorization: Bearer <token>".
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
  const port = values.port === undefined ? 8000 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid --port "${values.port}"\n`);
    process.exitCode = 1;
  } else {
    try {
      const root = positionals[0] ?? process.cwd();
      const allow: Cidr[] | undefined = values.allow === undefined ? undefined : parseAllow(values.allow);
      const token = allow ? tokenFromEnv(loadEnv(root, process.env)) : undefined;
      const workers = poolSettingsFromEnv(loadEnv(root, process.env));
      const { url, server, token: active, tokenGenerated } = await startServer({ root, port, allow, host: values.host, token, workers });
      const listening = (server.address() as { port: number }).port;
      process.stdout.write(`mockdata UI on ${url}  (workspace: ${new URL("/app", url)}, root: ${root})\n`);
      process.stdout.write(workers.size > 0 ? `Generation: ${workers.size} worker thread${workers.size === 1 ? "" : "s"}, queue of ${workers.maxQueue}, ${workers.jobTimeoutSecs} s limit per job\n` : "Generation: on the main thread (MOCKDATA_WORKERS=0); a big run will block the page\n");
      if (allow) {
        process.stdout.write(`Also open to ${allow.map((c) => c.text).join(", ")}: ${localAddresses().map((a) => `http://${a}:${listening}`).join("  ")}\n`);
        const shown = tokenGenerated ? active : "<your MOCKDATA_TOKEN>";
        process.stdout.write(`${tokenGenerated ? "Generated token (set MOCKDATA_TOKEN to keep one): " : "Token: from MOCKDATA_TOKEN. "}${tokenGenerated ? active : ""}\n`);
        process.stdout.write(`Open once from another machine: http://<address>:${listening}/app?token=${shown}\n`);
        process.stdout.write("Plain http: use a network you trust.\n");
      }
      process.stdout.write("Press Ctrl+C to stop.\n");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      process.stderr.write(err.code === "EADDRINUSE" ? `Port ${values.port ?? 8000} is already in use (try --port)\n` : `${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
