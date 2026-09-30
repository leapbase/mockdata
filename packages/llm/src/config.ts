import { LLM_PROVIDERS, type LlmConfig } from "@mockdata/core";
import { LlmConfigError } from "./errors.js";

/** LlmConfig once provider and model are known. */
export type ResolvedLlmConfig = Omit<LlmConfig, "provider" | "model"> & {
  provider: NonNullable<LlmConfig["provider"]>;
  model: string;
  /** baseUrl came from the environment (or the localhost default), not from the schema, so a private address is the user's own choice. */
  trustedBaseUrl?: boolean;
};

type Provider = ResolvedLlmConfig["provider"];

const MODEL_ENV: Record<Provider, string | undefined> = {
  anthropic: "ANTHROPIC_MODEL",
  openai: "OPENAI_MODEL",
  ollama: "OLLAMA_MODEL",
  "openai-compatible": undefined,
};

const OLLAMA_DEFAULT_URL = "http://localhost:11434";

/** Ollama serves its OpenAI-compatible API under /v1; accept the bare host too. */
function ollamaApiUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Combine the schema's `llm` block with the environment (process env merged
 * with .env by the caller). Anything the schema sets wins; the environment
 * fills in the rest:
 *
 *   provider  <- AI_PROVIDER            (anthropic | openai | ollama | openai-compatible)
 *   model     <- ANTHROPIC_MODEL | OPENAI_MODEL | OLLAMA_MODEL   (by provider)
 *   baseUrl   <- OLLAMA_BASE_URL        (ollama only; defaults to localhost)
 *   API key   <- ANTHROPIC_API_KEY | OPENAI_API_KEY (read later by createProvider)
 */
export function resolveLlmConfig(
  fromSchema: LlmConfig | undefined,
  env: Record<string, string | undefined>,
): ResolvedLlmConfig {
  const rawProvider = fromSchema?.provider ?? env.AI_PROVIDER?.trim().toLowerCase();
  if (!rawProvider) {
    throw new LlmConfigError(`No LLM provider: set "llm.provider" in the schema or AI_PROVIDER in the environment/.env (${LLM_PROVIDERS.join(", ")})`);
  }
  if (!(LLM_PROVIDERS as readonly string[]).includes(rawProvider)) {
    throw new LlmConfigError(`Unknown LLM provider "${rawProvider}" (expected ${LLM_PROVIDERS.join(", ")})`);
  }
  const provider = rawProvider as Provider;

  const modelEnv = MODEL_ENV[provider];
  const model = fromSchema?.model ?? (modelEnv ? env[modelEnv]?.trim() : undefined);
  if (!model) {
    throw new LlmConfigError(
      `No model for provider "${provider}": set "llm.model" in the schema${modelEnv ? ` or ${modelEnv} in the environment/.env` : ""}`,
    );
  }

  let baseUrl = fromSchema?.baseUrl;
  const trustedBaseUrl = provider === "ollama" && !baseUrl ? true : undefined;
  if (provider === "ollama") {
    baseUrl = ollamaApiUrl(baseUrl ?? env.OLLAMA_BASE_URL?.trim() ?? OLLAMA_DEFAULT_URL);
  }
  if (provider === "openai-compatible" && !baseUrl) {
    throw new LlmConfigError(`Provider "openai-compatible" needs "llm.baseUrl" in the schema`);
  }
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      throw new LlmConfigError(`Invalid LLM base URL (from "llm.baseUrl" or OLLAMA_BASE_URL)`);
    }
  }

  return { ...fromSchema, provider, model, baseUrl, ...(trustedBaseUrl ? { trustedBaseUrl } : {}) };
}
