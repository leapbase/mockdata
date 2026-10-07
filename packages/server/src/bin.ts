#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadEnv, localAddresses, parseAllow, tokenFromEnv, type Cidr } from "@mockdata/cli";
import { accountsFromEnv, backupAccounts } from "./accounts/runtime.js";
import { poolSettingsFromEnv } from "./workers/factory.js";
import { startServer } from "./listen.js";

const HELP = `mockdata-ui - local web UI for mockdata

Usage:
  mockdata-ui [root] [--port <n>] [--allow <ranges>] [--host <address>] [--data-dir <dir>]
  mockdata-ui [root] --backup <file> [--data-dir <dir>]

  root            folder holding your schema files and .env (default: current directory)
  --port <n>      port (default 4747)
  --allow <list>  also serve these private ranges, comma separated: 100.100.1.x (a /24),
                  a CIDR such as 192.168.0.0/16, or a single IP. Only 10/8, 172.16/12,
                  192.168/16 and 100.64/10 are accepted, at most a /16 wide. Without
                  --allow the UI answers on 127.0.0.1 only.
  --host <addr>   address to bind (default 127.0.0.1, or 0.0.0.0 with --allow)
  --data-dir <d>  accounts mode: where accounts and each user's private folder live
                  (default $MOCKDATA_DATA_DIR or ./mockdata-data)
  --backup <file> accounts mode: write a consistent copy of the account database to <file>
                  and exit. Safe while the server runs; back up <data-dir>/users with any file tool.
  -h, --help

Generation runs in worker threads so a big run does not freeze the page for everyone: MOCKDATA_WORKERS
(threads; default up to 4, 0 = run on the main thread), MOCKDATA_WORKER_QUEUE (waiting jobs, 16),
MOCKDATA_JOB_TIMEOUT_SECS (120) and MOCKDATA_WORKER_HEAP_MB (2048) in the environment or .env.

Accounts mode: set MOCKDATA_PUBLIC_URL (https://your-domain, or http://localhost:<port> to try it)
in the environment or .env. Everyone then signs in, including localhost, each user gets a private
folder, and the operator's LLM keys are shared under per-user limits. Needs SMTP_* (email sign-up)
and/or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET. Put a reverse proxy that terminates https in front;
the UI listens on 127.0.0.1. --allow and MOCKDATA_TOKEN are for private-network mode and cannot be
combined with it. Root is then only where .env is read.

Machines other than this one must present a shared secret: set MOCKDATA_TOKEN (16+ characters,
in the environment or .env) or one is generated and printed at start. Open the UI once with
http://<address>:<port>/app?token=<token> (it sets a cookie); scripts send "Authorization: Bearer <token>".
Anyone holding the token can read and write schema files under root and use your LLM keys.
Traffic is plain http, so use a network you trust (for example a Tailscale tailnet).
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, allow: { type: "string" }, host: { type: "string" }, "data-dir": { type: "string" }, backup: { type: "string" }, help: { type: "boolean", short: "h" } },
});

if (values.help) {
  process.stdout.write(HELP);
} else if (positionals.length > 1) {
  process.stderr.write(`Expected at most one folder\n\n${HELP}`);
  process.exitCode = 1;
} else if (values.backup !== undefined) {
  try {
    const source = await backupAccounts(process.env, { configRoot: positionals[0] ?? process.cwd(), dataDir: values["data-dir"], target: values.backup });
    process.stdout.write(`Backed up ${source} to ${values.backup}\n`);
  } catch (e) {
    process.stderr.write(`Backup failed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
} else {
  const port = values.port === undefined ? 4747 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid --port "${values.port}"\n`);
    process.exitCode = 1;
  } else {
    try {
      const root = positionals[0] ?? process.cwd();
      const allow: Cidr[] | undefined = values.allow === undefined ? undefined : parseAllow(values.allow);
      const accounts = await accountsFromEnv(process.env, { configRoot: root, dataDir: values["data-dir"] });
      const token = allow ? tokenFromEnv(loadEnv(root, process.env)) : undefined;
      const workers = poolSettingsFromEnv(loadEnv(root, process.env));
      const { url, server, token: active, tokenGenerated } = await startServer({ root, port, allow, host: values.host, token, accounts, workers });
      const listening = (server.address() as { port: number }).port;
      process.stdout.write(`mockdata UI on ${url}  (workspace: ${new URL("/app", url)}, root: ${root})\n`);
      process.stdout.write(workers.size > 0 ? `Generation: ${workers.size} worker thread${workers.size === 1 ? "" : "s"}, queue of ${workers.maxQueue}, ${workers.jobTimeoutSecs} s limit per job\n` : "Generation: on the main thread (MOCKDATA_WORKERS=0); a big run will block the page\n");
      if (accounts) {
        const { publicUrl, dataDir } = accounts.config;
        process.stdout.write(`Accounts mode: sign-in required for everyone. Public address ${publicUrl.origin}, data in ${dataDir}\n`);
        process.stdout.write(`MCP for signed-in users: ${publicUrl.origin}/mcp (API keys from the account menu)\n`);
        process.stdout.write(`Sign-up: ${[accounts.emailEnabled && "email", accounts.google && "Google"].filter(Boolean).join(" and ")}. Per-user limits: ${accounts.limits.llmDailyRows} LLM rows/day, ${accounts.limits.maxRows} rows/run, ${Math.round(accounts.limits.userQuotaBytes / 1024 / 1024)} MB storage, ${accounts.limits.maxRuns} runs at once overall.\n`);
        if (!publicUrl.secure) process.stdout.write("Plain http on localhost: for trying it out only. A public site needs an https reverse proxy in front.\n");
        if (accounts.emailEnabled) await accounts.mailer.verifyConnection().catch((e) => process.stderr.write(`Warning: the SMTP server could not be reached (${accounts.mailer.formatError(e)}); sign-up emails will fail until it can.\n`));
      }
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
      process.stderr.write(err.code === "EADDRINUSE" ? `Port ${values.port ?? 4747} is already in use (try --port)\n` : `${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
