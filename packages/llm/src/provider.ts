import type { LlmConfig } from "@mockdata/core";

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Completion {
  text: string;
  usage: Usage;
}

/** Minimal provider contract: one prompt in, text and token usage out. */
export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<Completion>;
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for network failures. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
  /** Worth retrying: rate limits, server errors, network failures. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export interface ProviderDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const DEFAULT_KEY_ENV: Record<string, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

async function postJson(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (e) {
    throw new LlmHttpError(`Network error calling ${url}: ${(e as Error).message}`, 0);
  }
  const text = await res.text();
  if (!res.ok) throw new LlmHttpError(`${url} returned ${res.status}: ${text.slice(0, 300)}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmHttpError(`${url} returned non-JSON: ${text.slice(0, 200)}`, 502);
  }
}

/** Build a provider from the non-secret config; the API key comes from the environment. */
export function createProvider(config: LlmConfig, deps: ProviderDeps = {}): LlmProvider {
  const f = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const keyEnv = config.apiKeyEnv ?? DEFAULT_KEY_ENV[config.provider];
  const apiKey = keyEnv ? env[keyEnv] : undefined;

  if (config.provider !== "openai-compatible" && !apiKey) {
    throw new LlmConfigError(`Missing API key: set the ${keyEnv} environment variable`);
  }
  if (config.provider === "openai-compatible" && config.apiKeyEnv && !apiKey) {
    throw new LlmConfigError(`Missing API key: set the ${config.apiKeyEnv} environment variable`);
  }

  if (config.provider === "anthropic") {
    const base = (config.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    return {
      name: `anthropic:${config.model}`,
      async complete(req) {
        const json = await postJson(
          f,
          `${base}/v1/messages`,
          { "x-api-key": apiKey!, "anthropic-version": "2023-06-01" },
          { model: config.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: "user", content: req.user }] },
        );
        const text = (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        return { text, usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 } };
      },
    };
  }

  // openai and openai-compatible share the chat completions wire format.
  const base = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const limitKey = config.provider === "openai" ? "max_completion_tokens" : "max_tokens";
  return {
    name: `${config.provider}:${config.model}`,
    async complete(req) {
      const json = await postJson(
        f,
        `${base}/chat/completions`,
        apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        {
          model: config.model,
          [limitKey]: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        },
      );
      const text = json.choices?.[0]?.message?.content ?? "";
      return { text, usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 } };
    },
  };
}
