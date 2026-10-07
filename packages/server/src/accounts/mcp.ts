import { existsSync, lstatSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { UserError } from "@mockdata/cli";
import { createServer, McpSessions, mcpReply, type HostedHooks } from "@mockdata/mcp";
import { publicMessage } from "../errors.js";
import type { Ctx } from "../http.js";
import type { Policy } from "../hosted.js";
import { accountPolicy } from "./policy.js";
import type { AccountsRuntime } from "./runtime.js";

/** Sessions the whole server keeps open, and per user. Each holds an MCP server (a few kB) until it idles out. */
const MAX_SESSIONS = 500;
const MAX_SESSIONS_PER_USER = 5;
const SESSION_IDLE_MS = 30 * 60_000;
/** The same ceiling as a signed-in request to /api/ (a run carries the schema text). */
const MAX_BODY = 2 * 1024 * 1024;

const NEEDS_KEY = "An API key is required: create one under API keys in your account menu and send Authorization: Bearer <key>";

function bearer(header: string | string[] | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec([header].flat()[0] ?? "");
  return m?.[1];
}

/**
 * What a hosted caller is told about a failed tool call: messages written for callers as they are, anything else (a
 * file system error naming a server path, a bug) as a generic line, with the detail in the server log only.
 */
export function describeHostedError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const message = publicMessage(e, true);
  if (message !== (e as Error)?.message) process.stderr.write(`mcp: ${(e as Error)?.stack ?? String(e)}\n`);
  return message;
}

/** The tools' view of a shared server: the operator's model settings, this user's quotas, and the worker pool. */
export function hostedHooks(ctx: Ctx & { policy: Policy }): HostedHooks {
  const policy = ctx.policy;
  return {
    env: ctx.env,
    allowConnectionEnv: false, // a variable named by a user would read the operator's database
    async beforeValidate(schema) {
      await policy.throttleValidate();
      policy.checkSchema(schema);
    },
    async beforeInfer() {
      await policy.throttleRun();
    },
    async generate(schema, want) {
      const run = await policy.beginRun(schema); // rate, size and row caps, daily model budget, run slot
      try {
        const result = await ctx.runner.run({ kind: "sample", schema: run.schema, seed: want.seed, sampleRows: want.sampleRows, format: want.format, env: ctx.env() }, { signal: want.signal });
        return { counts: result.counts, report: result.report, sample: result.sample, texts: result.texts };
      } finally {
        run.done();
      }
    },
    describeError: describeHostedError,
    beforeWrite(files) {
      const incoming = files.reduce((n, f) => n + f.bytes, 0);
      const replaced = files.reduce((n, f) => n + (existsSync(f.file) ? lstatSync(f.file).size : 0), 0);
      policy.checkWrite(ctx.root, { netBytes: Math.max(0, incoming - replaced), newFiles: files.filter((f) => !existsSync(f.file)).length });
    },
  };
}

/**
 * The hosted MCP endpoint (accounts mode only): Streamable HTTP at /mcp, authenticated by a per-user API key in the
 * Authorization header (never a cookie, so a web page cannot ride a signed-in browser). Each user works in their own
 * folder, with the same quotas as the web UI; a session can only be used with a key of the user who opened it.
 */
export function createHostedMcp(base: Ctx, acc: AccountsRuntime) {
  const sessions = new McpSessions({ maxSessions: MAX_SESSIONS, maxPerOwner: MAX_SESSIONS_PER_USER, sessionIdleMs: SESSION_IDLE_MS, maxBody: MAX_BODY });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    const ip = acc.clientIp(req);
    if ((await acc.limiters.apiKeyFail.isLimited(ip))) {
      res.setHeader("retry-after", String(Math.max(1, (await acc.limiters.apiKeyFail.retryAfterSeconds(ip)))));
      return mcpReply(res, 429, "Too many requests with a wrong API key. Try again later.");
    }
    const key = bearer(req.headers.authorization);
    const user = await acc.apiKeys.lookup(key);
    if (!user) {
      if (key) (await acc.limiters.apiKeyFail.record(ip));
      res.setHeader("www-authenticate", 'Bearer realm="mockdata"');
      return mcpReply(res, 401, key ? "This API key is not valid (it may have been revoked)" : NEEDS_KEY);
    }
    const owner = String(user.id);
    if (!(await acc.limiters.mcpUser.hit(owner))) {
      res.setHeader("retry-after", String(Math.max(1, (await acc.limiters.mcpUser.retryAfterSeconds(owner)))));
      return mcpReply(res, 429, "You are sending requests too quickly. Try again in a moment.");
    }
    const ctx = { ...base, root: acc.userRoot(user), policy: accountPolicy(acc, user) };
    return sessions.handle(req, res, owner, () => createServer({ root: ctx.root, hosted: hostedHooks(ctx) }));
  }

  return {
    handle: (req: IncomingMessage, res: ServerResponse) =>
      handle(req, res).catch((e) => {
        process.stderr.write(`mcp: ${(e as Error).stack ?? String(e)}\n`);
        mcpReply(res, 500, "Something went wrong. Try again, and tell the operator if it keeps happening.");
      }),
    close: () => sessions.close(),
  };
}
