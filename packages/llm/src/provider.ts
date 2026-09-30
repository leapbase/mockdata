import type { ResolvedLlmConfig } from "./config.js";
import { LlmConfigError } from "./errors.js";

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

export interface ProviderDeps {
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default 120000); a timeout is a retryable failure. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const DEFAULT_KEY_ENV: Record<string, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** ollama and openai-compatible servers speak the OpenAI chat wire format; their key is optional. */
const KEY_OPTIONAL = new Set(["ollama", "openai-compatible"]);

async function postJson(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    const why = err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : err.message;
    throw new LlmHttpError(`Network error calling ${url}: ${why}`, 0);
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
export function createProvider(config: ResolvedLlmConfig, deps: ProviderDeps = {}): LlmProvider {
  const f = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const env = deps.env ?? process.env;
  const keyEnv = config.apiKeyEnv ?? DEFAULT_KEY_ENV[config.provider];
  const apiKey = keyEnv ? env[keyEnv] : undefined;

  // Required for hosted providers; for local servers only when the schema names a key variable.
  if (!apiKey && (!KEY_OPTIONAL.has(config.provider) || config.apiKeyEnv)) {
    throw new LlmConfigError(`Missing API key: set ${keyEnv} in the environment or .env`);
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
          timeoutMs,
        );
        const text = (json.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        return { text, usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 } };
      },
    };
  }

  // openai and openai-compatible share the chat completions wire format.
  const base = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  // Only OpenAI itself takes max_completion_tokens; compatible servers expect max_tokens.
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
        timeoutMs,
      );
      const text = json.choices?.[0]?.message?.content ?? "";
      return { text, usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 } };
    },
  };
}
