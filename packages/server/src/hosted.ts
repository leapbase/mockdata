import type { IncomingMessage, ServerResponse } from "node:http";
import type { PublicUrl } from "@mockdata/cli";
import type { DataSchemaT, LlmConfig } from "@mockdata/core";
import type { Ctx } from "./http.js";

/**
 * The seam between this server and a hosted, multi-user layer built on top of it (the local workspace has none).
 * A hosted layer implements `HostedPlugin` and passes it to `createApp` / `startServer` as `hosted`; the server then
 * asks it who the caller is and what they may do, and otherwise behaves as it does locally.
 */

/** A run the policy admitted: generate from `schema` (the policy may have tightened it), then call `done`. */
export interface RunTicket {
  schema: DataSchemaT;
  /** Free whatever the run held (a slot, a lease). Safe to call more than once. */
  done(): void;
}

/**
 * What one caller may do, bound to that caller for one request (`Ctx.policy`). Every method throws an error the
 * server turns into a plain response (`HttpError`, `QuotaError`, ...); none may echo values the caller sent.
 */
export interface Policy {
  /** Error text and names for status 500 and up are replaced by generic ones (the caller must not see internals). */
  readonly hideInternals: boolean;
  /** The operator, not the schema, chooses the model provider, endpoint and key. */
  readonly lockedModels: boolean;
  /** Database inference (`connectionEnv`) and the operator's database variable names are visible to the caller. */
  readonly allowDatabase: boolean;
  /** The `llm` block a schema may keep (everything it must not choose removed, the rest clamped). */
  lockLlm(cfg: LlmConfig | undefined): LlmConfig | undefined;
  /** Count one expensive request (generate, export, infer); throws when the caller is going too fast. */
  throttleRun(): Promise<void>;
  /** Count one schema check; has its own, higher, limit. */
  throttleValidate(): Promise<void>;
  /** Refuse schemas that are cheap to send but expensive to build. */
  checkSchema(schema: DataSchemaT): void;
  /** `checkSchema` plus the row cap, for a run that is not slot-gated. */
  checkRun(schema: DataSchemaT): void;
  /** Before a gated generation: throttle, schema and row caps, budgets, and the run slot. */
  beginRun(schema: DataSchemaT): Promise<RunTicket>;
  /**
   * Before writing files into the caller's folder. `netBytes` is what the write adds after replaced files free
   * their size, `newFiles` how many files it creates, `fileBytes` the size of the single file when there is one.
   */
  checkWrite(root: string, write: { netBytes: number; newFiles: number; fileBytes?: number }): void;
}

export interface HostedPlugin {
  /** Where browsers reach the server; the server never trusts loopback peers and needs no token when this is set. */
  readonly publicUrl: PublicUrl;
  /** Largest request body for `/api/` routes, in bytes. */
  readonly bodyMax: number;
  /** Headers added to every response. */
  responseHeaders(): Record<string, string>;
  /** MCP over HTTP at `/mcp`, authenticated by the plugin; `base` is the server's own context. */
  mcp(base: Ctx): { handle(req: IncomingMessage, res: ServerResponse): Promise<void> };
  /**
   * Plugin-owned `/api/` routes (sign-in and the like). Return true when the request was answered; false to let the
   * server route it. Runs for every `/api/` path.
   */
  handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /**
   * Identify the caller and return the context their request runs in (their own `root` and a `policy`).
   * Throws `HttpError(401)` when nobody is signed in.
   */
  contextFor(base: Ctx, req: IncomingMessage): Promise<Ctx>;
}

/** Admit a generation: the caller's policy decides when there is one, a local server admits everything. */
export async function beginRun(ctx: Ctx, schema: DataSchemaT): Promise<RunTicket> {
  return ctx.policy ? ctx.policy.beginRun(schema) : { schema, done: () => undefined };
}
