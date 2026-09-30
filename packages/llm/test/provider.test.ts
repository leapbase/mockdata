import { describe, expect, it } from "vitest";
import { createProvider, LlmConfigError, LlmHttpError } from "../src/index.js";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const req = { system: "sys", user: "hi", maxTokens: 100 };

describe("providers", () => {
  it("anthropic: sends the messages API shape and parses text and usage", async () => {
    const { f, calls } = fakeFetch(200, { content: [{ type: "text", text: '["a"]' }], usage: { input_tokens: 7, output_tokens: 3 } });
    const p = createProvider({ provider: "anthropic", model: "claude-x" }, { fetch: f, env: { ANTHROPIC_API_KEY: "k1" } });
    expect(await p.complete(req)).toEqual({ text: '["a"]', usage: { inputTokens: 7, outputTokens: 3 }, truncated: false });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k1");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "claude-x", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "hi" }] });
  });

  it("openai: uses chat completions with a bearer token", async () => {
    const { f, calls } = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const p = createProvider({ provider: "openai", model: "gpt-x" }, { fetch: f, env: { OPENAI_API_KEY: "k2" } });
    expect(await p.complete(req)).toEqual({ text: "x", usage: { inputTokens: 5, outputTokens: 2 }, truncated: false });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k2");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ max_completion_tokens: 100 });
  });

  it("openai-compatible: custom base URL, no key required, max_tokens", async () => {
    const { f, calls } = fakeFetch(200, { choices: [{ message: { content: "y" } }] });
    const p = createProvider({ provider: "openai-compatible", model: "llama3", baseUrl: "http://localhost:11434/v1/" }, { fetch: f, env: {} });
    expect((await p.complete(req)).text).toBe("y");
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ max_tokens: 100 });
  });

  it("fails clearly when the API key is missing, naming the env var", () => {
    expect(() => createProvider({ provider: "anthropic", model: "m" }, { env: {} })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createProvider({ provider: "openai", model: "m", apiKeyEnv: "MY_KEY" }, { env: {} })).toThrow(LlmConfigError);
  });

  it("marks 429/5xx/network errors retryable and 401 not", async () => {
    const env = { OPENAI_API_KEY: "k" };
    for (const [status, retryable] of [[429, true], [503, true], [401, false]] as const) {
      const p = createProvider({ provider: "openai", model: "m" }, { fetch: fakeFetch(status, "nope").f, env });
      const err = await p.complete(req).catch((e) => e);
      expect(err).toBeInstanceOf(LlmHttpError);
      expect(err.retryable).toBe(retryable);
    }
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const err = await createProvider({ provider: "openai", model: "m" }, { fetch: down, env }).complete(req).catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
  });
});

describe("truncation flag", () => {
  const env = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };
  it("anthropic: stop_reason max_tokens means truncated", async () => {
    const cut = createProvider({ provider: "anthropic", model: "m" }, { fetch: fakeFetch(200, { content: [{ type: "text", text: "[" }], stop_reason: "max_tokens" }).f, env });
    const ok = createProvider({ provider: "anthropic", model: "m" }, { fetch: fakeFetch(200, { content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" }).f, env });
    expect((await cut.complete(req)).truncated).toBe(true);
    expect((await ok.complete(req)).truncated).toBe(false);
  });
  it("openai and ollama: finish_reason length means truncated", async () => {
    for (const provider of ["openai", "ollama"] as const) {
      const cut = createProvider({ provider, model: "m" }, { fetch: fakeFetch(200, { choices: [{ message: { content: "[" }, finish_reason: "length" }] }).f, env });
      const ok = createProvider({ provider, model: "m" }, { fetch: fakeFetch(200, { choices: [{ message: { content: "[]" }, finish_reason: "stop" }] }).f, env });
      expect((await cut.complete(req)).truncated, provider).toBe(true);
      expect((await ok.complete(req)).truncated, provider).toBe(false);
    }
  });
});

describe("timeouts", () => {
  it("a hung server becomes a retryable network error instead of hanging forever", async () => {
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const p = createProvider({ provider: "ollama", model: "m" }, { fetch: hang, env: {}, timeoutMs: 20 });
    const err = await p.complete({ system: "s", user: "u", maxTokens: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.message).toMatch(/timed out after 20 ms/);
    expect(err.retryable).toBe(true);
  });

  describe("credential safety (schema may be untrusted)", () => {
    const env = { ANTHROPIC_API_KEY: "sk-secret", OPENAI_API_KEY: "sk-secret2", DATABASE_URL: "postgres://u:pw@h/db", MY_SERVICE_API_KEY: "svc" };

    it("never sends the anthropic/openai keys to a schema-chosen host", () => {
      for (const provider of ["anthropic", "openai"] as const) {
        expect(() => createProvider({ provider, model: "m", baseUrl: "https://evil.example" }, { env })).toThrow(LlmConfigError);
      }
      expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "https://evil.example", apiKeyEnv: "ANTHROPIC_API_KEY" }, { env })).toThrow(LlmConfigError);
      expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "https://evil.example", apiKeyEnv: "OPENAI_API_KEY" }, { env })).toThrow(LlmConfigError);
    });

    it("apiKeyEnv must look like an API key variable, not a database URL", () => {
      expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "https://api.example.com/v1", apiKeyEnv: "DATABASE_URL" }, { env })).toThrow(/apiKeyEnv/);
    });

    it("does not send a key over plain http to a non-loopback host", () => {
      expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://api.example.com/v1", apiKeyEnv: "MY_SERVICE_API_KEY" }, { env })).toThrow(LlmConfigError);
    });

    it("still allows a custom https host with its own key, and loopback http", async () => {
      const { f, calls } = fakeFetch(200, { choices: [{ message: { content: "ok" } }] });
      const p = createProvider({ provider: "openai-compatible", model: "m", baseUrl: "https://api.example.com/v1", apiKeyEnv: "MY_SERVICE_API_KEY" }, { fetch: f, env });
      await p.complete(req);
      expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer svc");
      expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:8000/v1", apiKeyEnv: "MY_SERVICE_API_KEY" }, { env })).not.toThrow();
    });

    it("refuses link-local/metadata hosts", () => {
      expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl: "http://169.254.169.254/latest" }, { env })).toThrow(LlmConfigError);
    });

    it("refuses schema-chosen private, internal and non-public hosts (SSRF)", () => {
      const bad = [
        "http://10.0.0.5/v1", "https://192.168.1.10/v1", "https://172.16.0.1/v1", "https://172.31.255.255/v1", "https://100.100.1.24/v1",
        "https://0.0.0.0/v1", "https://[fd00::1]/v1", "https://[fe80::1]/v1", "https://[::ffff:10.0.0.1]/v1", "https://[::ffff:192.168.0.1]/v1",
        "https://2130706433.evil/v1".replace("2130706433.evil", "0x0a000001"), "https://intranet/v1", "https://db.internal/v1", "https://printer.local/v1",
        "https://localhost.localdomain/v1",
      ];
      for (const baseUrl of bad) {
        expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl }, { env }), baseUrl).toThrow(LlmConfigError);
      }
      for (const baseUrl of ["https://api.example.com/v1", "https://8.8.8.8/v1", "https://172.32.0.1/v1", "http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"]) {
        expect(() => createProvider({ provider: "openai-compatible", model: "m", baseUrl }, { env }), baseUrl).not.toThrow();
      }
    });

    it("trusts a private base URL that came from the environment (Ollama on a LAN host)", () => {
      expect(() => createProvider({ provider: "ollama", model: "m", baseUrl: "http://100.100.1.24:11434/v1", trustedBaseUrl: true }, { env: {} })).not.toThrow();
      expect(() => createProvider({ provider: "ollama", model: "m", baseUrl: "http://100.100.1.24:11434/v1" }, { env: {} })).toThrow(LlmConfigError);
    });

    it("does not echo a remote response body or URL credentials in errors", async () => {
      const { f } = fakeFetch(500, "INTERNAL-SECRET-BODY");
      const p = createProvider({ provider: "openai-compatible", model: "m", baseUrl: "https://user:pw@api.example.com/v1?token=abc" }, { fetch: f, env: {} });
      const err = await p.complete(req).catch((e) => e as Error);
      expect(err.message).not.toMatch(/INTERNAL-SECRET-BODY|pw|token=abc|user:/);
      expect(err.message).toMatch(/500/);
    });

    it("keeps the response body for loopback and default hosts (useful API errors)", async () => {
      const { f } = fakeFetch(400, "model not found");
      const p = createProvider({ provider: "ollama", model: "m", baseUrl: "http://localhost:11434/v1" }, { fetch: f, env: {} });
      expect((await p.complete(req).catch((e) => e as Error)).message).toMatch(/model not found/);
    });
  });
});
