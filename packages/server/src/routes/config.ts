import { dbEnvNames } from "@mockdata/cli";
import { createProvider, resolveLlmConfig } from "@mockdata/llm";
import type { LlmConfig } from "@mockdata/core";
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
    return { ok: true, provider: createProvider(resolveLlmConfig(fromSchema, env), { env }).name };
  } catch (e) {
    // Config errors name variables, never values.
    return { ok: false, reason: (e as Error).message };
  }
}

/** What the UI may know about the setup: names and yes/no, never a secret value. */
export const getConfig: Handler = async (ctx, _req, res) => {
  sendJson(res, 200, { llm: llmStatus(ctx), dbEnv: dbEnvNames(ctx.env()) });
};
