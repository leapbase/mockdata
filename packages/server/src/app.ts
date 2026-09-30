import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, UserError } from "@mockdata/cli";
import { CycleError, GenerationError, SchemaError, ValidationError } from "@mockdata/core";
import { LlmConfigError, LlmFillError, LlmHttpError } from "@mockdata/llm";
import { assertLocal, HttpError, sendJson, type Ctx, type Handler } from "./http.js";
import { serveStatic } from "./static.js";
import { getConfig } from "./routes/config.js";
import { listFiles, readFile, writeFile } from "./routes/files.js";
import { inferRoute } from "./routes/infer.js";
import { generateRoute, streamRoute, validateRoute } from "./routes/run.js";

export interface AppOptions {
  /** Directory schemas live in and all paths are confined to; .env is read from here. Default: cwd. */
  root?: string;
  /** Environment (default process.env); .env under root is merged beneath it. */
  env?: Record<string, string | undefined>;
  /** Test hooks for the LLM layer. */
  llm?: Ctx["llm"];
  /** Built web app (default: packages/web/dist next to this package). */
  staticDir?: string;
}

const ROUTES: Record<string, Handler> = {
  "GET /api/config": getConfig,
  "GET /api/files": listFiles,
  "GET /api/file": readFile,
  "PUT /api/file": writeFile,
  "POST /api/validate": validateRoute,
  "POST /api/generate": generateRoute,
  "POST /api/generate/stream": streamRoute,
  "POST /api/infer": inferRoute,
};

/** Errors caused by the caller's schema or input are 400; failures talking to a model are 502. */
function statusFor(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof LlmFillError || e instanceof LlmHttpError) return 502;
  if (
    e instanceof UserError ||
    e instanceof SchemaError ||
    e instanceof CycleError ||
    e instanceof GenerationError ||
    e instanceof ValidationError ||
    e instanceof LlmConfigError
  ) {
    return 400;
  }
  return 500;
}

function sendError(res: ServerResponse, e: unknown): void {
  const err = e as Error;
  if (res.headersSent) {
    res.end();
    return;
  }
  // Error messages in this codebase name variables, never values.
  sendJson(res, statusFor(e), { error: { name: err.name, message: err.message } });
}

export function createApp(opts: AppOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(opts.root ?? process.cwd());
  const baseEnv = opts.env ?? process.env;
  const staticDir = opts.staticDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const ctx: Ctx = { root, env: () => loadEnv(root, baseEnv), llm: opts.llm ?? {} };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertLocal(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const route = ROUTES[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, "No such API route");
      await route(ctx, req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    serveStatic(staticDir, url.pathname, res);
  }

  return (req, res) => {
    handle(req, res).catch((e) => sendError(res, e));
  };
}
