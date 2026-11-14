import { lookup as dnsLookup } from "node:dns/promises";
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
  /**
   * Resolves a host name to its addresses, to refuse a schema-chosen public name that points at a private address.
   * Default: the system resolver, but only with the real `fetch` (an injected `fetch` never touches the network).
   */
  lookup?: (host: string) => Promise<string[]>;
}

/** Largest reply body read from a model server: a schema-chosen host could otherwise stream gigabytes into memory. */
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

const DEFAULT_KEY_ENV: Record<string, string | undefined> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** ollama and openai-compatible servers speak the OpenAI chat wire format; their key is optional. */
const KEY_OPTIONAL = new Set(["ollama", "openai-compatible"]);

const RESERVED_KEY_ENV: Record<string, string> = { ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "openai" };
const API_KEY_ENV_NAME = /^[A-Z][A-Z0-9_]*_API_(KEY|TOKEN)$/;

function hostname(url: string): string {
  // A trailing dot names the same host ("metadata.google.internal."), so it must not slip past the name checks.
  return new URL(url).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
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
  // 64:ff9b::/96 is NAT64: an IPv4 address (possibly a private one) in IPv6 clothing.
  if (host.includes(":")) return host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || /^64:ff9b:/.test(host);
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
function assertSafeTarget(config: ResolvedLlmConfig, apiKey: string | undefined, env: Record<string, string | undefined>): void {
  if (config.apiKeyEnv) {
    if (!API_KEY_ENV_NAME.test(config.apiKeyEnv)) {
      throw new LlmConfigError(`"llm.apiKeyEnv" must be an upper-case variable name ending in _API_KEY or _API_TOKEN`);
    }
    const owner = RESERVED_KEY_ENV[config.apiKeyEnv];
    if (owner && owner !== config.provider) {
      throw new LlmConfigError(`"llm.apiKeyEnv" names the ${owner} key, which is only used with provider "${owner}"`);
    }
  }
  if (config.baseUrl) {
    const host = hostname(config.baseUrl);
    if (config.provider === "anthropic" || config.provider === "openai") {
      throw new LlmConfigError(`"llm.baseUrl" is not allowed for provider "${config.provider}" (its key is only sent to the official API); use "openai-compatible" for a custom endpoint`);
    }
    // The schema chose this host. Without the owner's say-so it gets no key at all: `apiKeyEnv` can name any
    // *_API_KEY in the environment, so a downloaded schema could otherwise post one to a server of its choosing.
    if (apiKey && !config.trustedBaseUrl && !isLoopback(host) && !allowedHosts(env).has(host)) {
      throw new LlmConfigError(
        `An API key is only sent to a host you have approved: add ${host} to MOCKDATA_LLM_HOSTS in the environment/.env (comma-separated host names) to use this "llm.baseUrl" with a key`,
      );
    }
    if (isLinkLocal(host)) throw new LlmConfigError(`"llm.baseUrl" points at a link-local or metadata address`);
    if (!config.trustedBaseUrl && isNonPublic(host)) {
      throw new LlmConfigError(`"llm.baseUrl" points at a private or internal address; set OLLAMA_BASE_URL in the environment/.env to use a server on your network`);
    }
    if (apiKey && new URL(config.baseUrl).protocol !== "https:" && !isLoopback(host)) {
      throw new LlmConfigError(`An API key is only sent over https (or to localhost); "llm.baseUrl" must use https`);
    }
  }
}

/** Hosts the owner approved (MOCKDATA_LLM_HOSTS) to receive a key at a schema-chosen `llm.baseUrl`. */
function allowedHosts(env: Record<string, string | undefined>): Set<string> {
  return new Set((env.MOCKDATA_LLM_HOSTS ?? "").split(",").map((h) => h.trim().replace(/\.$/, "").toLowerCase()).filter(Boolean));
}

/** Read a reply as text, giving up past `MAX_REPLY_BYTES` instead of buffering whatever the server sends. */
async function readCapped(res: Response, shown: string): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new LlmHttpError(`${shown} sent a reply larger than ${MAX_REPLY_BYTES / 1024 / 1024} MB`, 502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface PostOptions {
  timeoutMs: number;
  /** Show the server's own words in errors. Only for the official APIs and a server the owner configured. */
  echoBody: boolean;
  /** Runs before the first request; throws to refuse the target. */
  preflight?: () => Promise<void>;
}

async function postJson(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, opts: PostOptions): Promise<any> {
  const { timeoutMs, echoBody } = opts;
  const shown = redactUrl(url);
  await opts.preflight?.();
  let res: Response;
  let text: string;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // A redirect would replay the prompt (and, same-origin, the key) at an address nobody checked.
      redirect: "error",
    });
    text = await readCapped(res, shown);
  } catch (e) {
    if (e instanceof LlmHttpError) throw e;
    const err = e as Error;
    const why = err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : err.message;
    throw new LlmHttpError(`Network error calling ${shown}: ${why}`, 0);
  }
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

  assertSafeTarget(config, apiKey, env);

  // Error bodies are only echoed from the official APIs and from a server the owner configured in the environment:
  // a schema-chosen address (localhost included) must not be able to read a local service back through messages.
  const echoBody = !config.baseUrl || config.trustedBaseUrl === true;
  // Name checks cannot see where a name points, so a schema-chosen public name is resolved once and every address
  // judged. (The connection resolves again, so this narrows DNS tricks rather than closing them.)
  const lookup = deps.lookup ?? (deps.fetch ? undefined : async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address));
  let checked: Promise<void> | undefined;
  const preflight =
    config.baseUrl && !config.trustedBaseUrl && lookup
      ? () =>
          (checked ??= (async () => {
            const host = hostname(config.baseUrl!);
            if (isLoopback(host) || /^[\d.]+$/.test(host) || host.includes(":")) return; // literals were judged by name
            let addresses: string[];
            try {
              addresses = await lookup(host);
            } catch {
              return; // unresolvable: the request itself reports it
            }
            if (addresses.map((a) => a.toLowerCase()).some((a) => isLinkLocal(a) || isNonPublic(a) || isLoopback(a))) {
              throw new LlmConfigError(`"llm.baseUrl" resolves to a private, local or link-local address; set OLLAMA_BASE_URL in the environment/.env to use a server on your network`);
            }
          })())
      : undefined;
  const post: PostOptions = { timeoutMs, echoBody, preflight };

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
          post,
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
        post,
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
