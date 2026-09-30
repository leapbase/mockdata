import { dbEnvNames } from "@mockdata/cli";
import { createProvider, resolveLlmConfig } from "@mockdata/llm";
import type { LlmConfig } from "@mockdata/core";
import { lockedLlmConfig } from "../accounts/guards.js";
import { MODELS_OFF } from "../errors.js";
import { sendJson, type Ctx, type Handler } from "../http.js";

export type LlmStatus = { ok: true; provider: string } | { ok: false; reason: string };

/**
 * Whether LLM columns can run: the schema's `llm` block wins over the
 * environment, as it does when generating. Only names and yes/no come back.
 */
export function llmStatus(ctx: Ctx, fromSchema?: LlmConfig): LlmStatus {
  if (ctx.llm.provider) return { ok: true, provider: ctx.llm.provider.name };
  const env = ctx.env();
  try {
    // createProvider only checks configuration (including the key); it makes no request.
    const config = ctx.accounts ? lockedLlmConfig(fromSchema) : fromSchema; // accounts mode: the operator's settings, whatever the schema says
    return { ok: true, provider: createProvider(resolveLlmConfig(config, env), { env }).name };
  } catch (e) {
    // Config errors name variables, never values; on a public server even the names are the operator's business.
    return { ok: false, reason: ctx.accounts ? MODELS_OFF : (e as Error).message };
  }
}

/** What the UI may know about the setup: names and yes/no, never a secret value. */
export const getConfig: Handler = async (ctx, _req, res) => {
  sendJson(res, 200, { llm: llmStatus(ctx), dbEnv: ctx.accounts ? [] : dbEnvNames(ctx.env()) }); // accounts mode: database variables belong to the operator
};
