#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer } from "./listen.js";

const HELP = `mockdata-ui - local web UI for mockdata

Usage:
  mockdata-ui [root] [--port <n>]

  root        folder holding your schema files and .env (default: current directory)
  --port <n>  port on 127.0.0.1 (default 4747)
  -h, --help
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, help: { type: "boolean", short: "h" } },
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
      const { url } = await startServer({ root, port });
      process.stdout.write(`mockdata UI on ${url}  (root: ${root})\nPress Ctrl+C to stop.\n`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      process.stderr.write(err.code === "EADDRINUSE" ? `Port ${values.port ?? 4747} is already in use (try --port)\n` : `${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
