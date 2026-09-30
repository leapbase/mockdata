import { dbEnvNames } from "@mockdata/cli";
import { createProvider, resolveLlmConfig } from "@mockdata/llm";
import { sendJson, type Handler } from "../http.js";

/** What the UI may know about the setup: names and yes/no, never a secret value. */
export const getConfig: Handler = async (ctx, _req, res) => {
  const env = ctx.env();
  let llm: { ok: true; provider: string } | { ok: false; reason: string };
  if (ctx.llm.provider) {
    llm = { ok: true, provider: ctx.llm.provider.name };
  } else {
    try {
      // createProvider only checks configuration (including the key); it makes no request.
      llm = { ok: true, provider: createProvider(resolveLlmConfig(undefined, env), { env }).name };
    } catch (e) {
      // Config errors name variables, never values.
      llm = { ok: false, reason: (e as Error).message };
    }
  }
  sendJson(res, 200, { llm, dbEnv: dbEnvNames(env) });
};
