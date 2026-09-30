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
    expect(await p.complete(req)).toEqual({ text: '["a"]', usage: { inputTokens: 7, outputTokens: 3 } });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k1");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "claude-x", max_tokens: 100, system: "sys", messages: [{ role: "user", content: "hi" }] });
  });

  it("openai: uses chat completions with a bearer token", async () => {
    const { f, calls } = fakeFetch(200, { choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const p = createProvider({ provider: "openai", model: "gpt-x" }, { fetch: f, env: { OPENAI_API_KEY: "k2" } });
    expect(await p.complete(req)).toEqual({ text: "x", usage: { inputTokens: 5, outputTokens: 2 } });
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
