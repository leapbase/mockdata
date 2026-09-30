import type { IncomingMessage, ServerResponse } from "node:http";
import { localRequestProblem, type NetworkAccess } from "@mockdata/cli";
import type { AccountUser } from "@mockdata/accounts";
import type { GenerateWithLlmOptions } from "@mockdata/llm";
import type { AccountsRuntime } from "./accounts/runtime.js";
import type { Runner } from "./workers/runner.js";

export interface Ctx {
  root: string;
  /** Environment for provider and connection settings: .env under root beneath the real environment, re-read on every call. */
  env: () => Record<string, string | undefined>;
  /** Test hooks for the LLM layer. */
  llm: Pick<GenerateWithLlmOptions, "provider" | "fetch" | "sleep">;
  /** Where generation, filling and serializing run (a worker pool, or the calling thread in tests). */
  runner: Runner;
  /** Accounts mode only: the account machinery and the signed-in user (`root` is then that user's private folder). */
  accounts?: AccountsRuntime;
  user?: AccountUser;
}

export type Handler = (ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A stable machine-readable reason the UI can switch on (never a value the caller sent). */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const MAX_BODY = 10 * 1024 * 1024;
/** Refuse requests that were not addressed to localhost or that a foreign web page initiated (DNS rebinding, CSRF). */
export function assertLocal(req: IncomingMessage, access?: NetworkAccess): void {
  const problem = localRequestProblem(req.headers.host, req.headers.origin, access);
  if (problem) throw new HttpError(403, problem);
}

const bodyLimits = new WeakMap<IncomingMessage, number>();
/** Lower the body limit for one request (accounts mode), however the body is framed. */
export function setBodyLimit(req: IncomingMessage, bytes: number): void {
  bodyLimits.set(req, bytes);
}

export async function readJson(req: IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
  maxBytes = Math.min(maxBytes, bodyLimits.get(req) ?? Infinity);
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "Body must be a JSON object");
  return value as Record<string, unknown>;
}

type Body = Record<string, unknown>;
const bad = (key: string, what: string) => new HttpError(400, `"${key}" must be ${what}`);

export function reqString(b: Body, key: string): string {
  const v = b[key];
  if (typeof v !== "string") throw bad(key, "a string");
  return v;
}
export function optString(b: Body, key: string): string | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(key, "a string");
  return v;
}
export function optInt(b: Body, key: string, min: number, max: number): number | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(key, `an integer from ${min} to ${max}`);
  return v;
}
export function optBool(b: Body, key: string): boolean | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw bad(key, "true or false");
  return v;
}
export function optEnum<T extends string>(b: Body, key: string, allowed: readonly T[]): T | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw bad(key, `one of ${allowed.join(", ")}`);
  return v as T;
}
export function optStringArray(b: Body, key: string): string[] | undefined {
  const v = b[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw bad(key, "a list of strings");
  return v as string[];
}

/** A signal that fires when the client goes away, so queued work can be dropped and a model run stops. */
export function abortOnClose(res: ServerResponse): AbortSignal {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  return abort.signal;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
