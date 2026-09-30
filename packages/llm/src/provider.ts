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
  /** The provider stopped because it hit the token limit, so `text` is cut off. */
  truncated?: boolean;
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

const RESERVED_KEY_ENV: Record<string, string> = { ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "openai" };
const API_KEY_ENV_NAME = /^[A-Z][A-Z0-9_]*_API_(KEY|TOKEN)$/;
const DEFAULT_HOSTS = new Set(["api.anthropic.com", "api.openai.com"]);

function hostname(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Cloud metadata and link-local addresses: never a legitimate model server. */
function isLinkLocal(host: string): boolean {
  return /^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || host === "metadata.google.internal";
}

/** Addresses and names that only make sense inside a network: a schema must not aim the client at them. */
function isNonPublic(host: string): boolean {
  if (isLoopback(host)) return false;
  // IPv4-mapped IPv6 (the URL parser writes ::ffff:10.0.0.1 as ::ffff:a00:1): judge the embedded IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isNonPublic(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) || isLoopback(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a >= 224;
  }
  if (host.includes(":")) return host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  // A name with no dot is a LAN short name; these suffixes are never public DNS.
  return !host.includes(".") || /\.(internal|local|localdomain|lan|home|corp|intranet)$/.test(host);
}

/** Origin and path only: no credentials or query string from the configured URL. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

/**
 * The schema (possibly untrusted) can set baseUrl and apiKeyEnv, so this keeps
 * credentials from reaching a host the user did not choose in the environment.
 */
function assertSafeTarget(config: ResolvedLlmConfig, apiKey: string | undefined): void {
  if (config.baseUrl) {
    const host = hostname(config.baseUrl);
    if (isLinkLocal(host)) throw new LlmConfigError(`"llm.baseUrl" points at a link-local or metadata address`);
    if (!config.trustedBaseUrl && isNonPublic(host)) {
      throw new LlmConfigError(`"llm.baseUrl" points at a private or internal address; set OLLAMA_BASE_URL in the environment/.env to use a server on your network`);
    }
    if (config.provider === "anthropic" || config.provider === "openai") {
      throw new LlmConfigError(`"llm.baseUrl" is not allowed for provider "${config.provider}" (its key is only sent to the official API); use "openai-compatible" for a custom endpoint`);
    }
    if (apiKey && new URL(config.baseUrl).protocol !== "https:" && !isLoopback(host)) {
      throw new LlmConfigError(`An API key is only sent over https (or to localhost); "llm.baseUrl" must use https`);
    }
  }
  if (config.apiKeyEnv) {
    if (!API_KEY_ENV_NAME.test(config.apiKeyEnv)) {
      throw new LlmConfigError(`"llm.apiKeyEnv" must be an upper-case variable name ending in _API_KEY or _API_TOKEN`);
    }
    const owner = RESERVED_KEY_ENV[config.apiKeyEnv];
    if (owner && owner !== config.provider) {
      throw new LlmConfigError(`"llm.apiKeyEnv" names the ${owner} key, which is only used with provider "${owner}"`);
    }
  }
}

async function postJson(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  // Response bodies are only echoed from loopback and the official APIs, so a
  // schema-chosen host cannot use error messages to read back internal services.
  const host = hostname(url);
  const echoBody = isLoopback(host) || DEFAULT_HOSTS.has(host);
  const shown = redactUrl(url);
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
    throw new LlmHttpError(`Network error calling ${shown}: ${why}`, 0);
  }
  const text = await res.text();
  if (!res.ok) throw new LlmHttpError(`${shown} returned ${res.status}${echoBody ? `: ${text.slice(0, 300)}` : ""}`, res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmHttpError(`${shown} returned non-JSON${echoBody ? `: ${text.slice(0, 200)}` : ""}`, 502);
  }
}

/** Build a provider from the non-secret config; the API key comes from the environment. */
export function createProvider(config: ResolvedLlmConfig, deps: ProviderDeps = {}): LlmProvider {
  const f = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const env = deps.env ?? process.env;
  const keyEnv = config.apiKeyEnv ?? DEFAULT_KEY_ENV[config.provider];
  const apiKey = keyEnv ? env[keyEnv] : undefined;

  assertSafeTarget(config, apiKey);

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
        return {
          text,
          usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
          truncated: json.stop_reason === "max_tokens",
        };
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
      return {
        text,
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        truncated: json.choices?.[0]?.finish_reason === "length",
      };
    },
  };
}
