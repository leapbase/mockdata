import { describe, expect, it } from "vitest";
import { createProvider, LlmConfigError, resolveLlmConfig } from "../src/index.js";

describe("resolveLlmConfig", () => {
  it("reads provider and model from the environment (your .env names)", () => {
    expect(resolveLlmConfig(undefined, { AI_PROVIDER: "anthropic", ANTHROPIC_MODEL: "claude-x" })).toMatchObject({ provider: "anthropic", model: "claude-x" });
    expect(resolveLlmConfig(undefined, { AI_PROVIDER: "OpenAI ", OPENAI_MODEL: "gpt-x" })).toMatchObject({ provider: "openai", model: "gpt-x" });
  });

  it("ollama: base URL from OLLAMA_BASE_URL with /v1 appended once, localhost by default", () => {
    const env = { AI_PROVIDER: "ollama", OLLAMA_MODEL: "llama3" };
    expect(resolveLlmConfig(undefined, { ...env, OLLAMA_BASE_URL: "http://100.100.1.24:11434" }).baseUrl).toBe("http://100.100.1.24:11434/v1");
    expect(resolveLlmConfig(undefined, { ...env, OLLAMA_BASE_URL: "http://h:11434/v1/" }).baseUrl).toBe("http://h:11434/v1");
    expect(resolveLlmConfig(undefined, env).baseUrl).toBe("http://localhost:11434/v1");
  });

  it("schema values win over the environment; the environment fills the gaps", () => {
    const env = { AI_PROVIDER: "ollama", OLLAMA_MODEL: "env-model", ANTHROPIC_MODEL: "env-claude" };
    expect(resolveLlmConfig({ provider: "anthropic", batchSize: 5 }, env)).toMatchObject({ provider: "anthropic", model: "env-claude", batchSize: 5 });
    expect(resolveLlmConfig({ model: "pinned" }, env)).toMatchObject({ provider: "ollama", model: "pinned" });
  });

  it("explains what is missing, naming variables but never values", () => {
    expect(() => resolveLlmConfig(undefined, {})).toThrow(/AI_PROVIDER/);
    expect(() => resolveLlmConfig(undefined, { AI_PROVIDER: "gemini" })).toThrow(/Unknown LLM provider "gemini"/);
    expect(() => resolveLlmConfig(undefined, { AI_PROVIDER: "openai" })).toThrow(/OPENAI_MODEL/);
    expect(() => resolveLlmConfig({ provider: "openai-compatible", model: "m" }, {})).toThrow(/baseUrl/);
    expect(() => resolveLlmConfig({ provider: "openai-compatible", model: "m", baseUrl: "not a url" }, {})).toThrow(LlmConfigError);
  });
});

describe("ollama provider", () => {
  it("talks OpenAI chat format to the resolved URL without an API key", async () => {
    let url = "";
    let auth: string | undefined;
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      auth = (init.headers as Record<string, string>).authorization;
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
    }) as unknown as typeof fetch;
    const config = resolveLlmConfig(undefined, { AI_PROVIDER: "ollama", OLLAMA_MODEL: "llama3", OLLAMA_BASE_URL: "http://h:11434" });
    const p = createProvider(config, { fetch: f, env: {} });
    expect(p.name).toBe("ollama:llama3");
    expect((await p.complete({ system: "s", user: "u", maxTokens: 10 })).text).toBe("hi");
    expect(url).toBe("http://h:11434/v1/chat/completions");
    expect(auth).toBeUndefined();
  });

  it("marks a base URL from the environment as trusted and one from the schema as not", () => {
    const env = { AI_PROVIDER: "ollama", OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "http://100.100.1.24:11434" };
    expect(resolveLlmConfig(undefined, env).trustedBaseUrl).toBe(true);
    expect(resolveLlmConfig({ baseUrl: "http://10.0.0.5:11434" }, env).trustedBaseUrl).toBeFalsy();
  });
});
