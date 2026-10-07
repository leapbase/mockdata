import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot, rawRequest } from "./helpers.js";

describe("localhost guard", () => {
  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const { url } = await boot();
    const r = await rawRequest(url, "/api/config", { host: "evil.example" });
    expect(r.status).toBe(403);
  });
  it("rejects a foreign Origin and any localhost Origin that is not the Host it addressed", async () => {
    const { url } = await boot();
    expect((await rawRequest(url, "/api/config", { origin: "http://evil.example" })).status).toBe(403);
    // Another local dev server or app on a different port is cross-origin.
    expect((await rawRequest(url, "/api/config", { origin: "http://localhost:5173" })).status).toBe(403);
    // Vite's dev proxy forwards the browser's own Host, so its Origin matches.
    expect((await rawRequest(url, "/api/config", { host: "localhost:5173", origin: "http://localhost:5173" })).status).toBe(200);
    expect((await rawRequest(url, "/api/config", { origin: "null" })).status).toBe(403);
  });
});

describe("routing", () => {
  it("answers unknown API routes with a JSON 404", async () => {
    const { get } = await boot();
    const r = await get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/No such API route/);
  });
});

describe("GET /api/config", () => {
  it("explains what is missing without inventing a provider", async () => {
    const { get } = await boot();
    const r = await get("/api/config");
    expect(r.json.llm.ok).toBe(false);
    expect(r.json.llm.reason).toMatch(/AI_PROVIDER/);
    expect(r.json.dbEnv).toEqual([]);
  });

  it("reports the provider and database variable names, never their values", async () => {
    const env = {
      AI_PROVIDER: "anthropic",
      ANTHROPIC_MODEL: "some-model",
      ANTHROPIC_API_KEY: "sk-very-secret",
      DATABASE_URL: "postgres://user:hunter2@host/db",
    };
    const { get } = await boot({ env });
    const r = await get("/api/config");
    expect(r.json.llm).toEqual({ ok: true, provider: "anthropic:some-model" });
    expect(r.json.dbEnv).toEqual(["DATABASE_URL"]);
    expect(r.raw).not.toContain("sk-very-secret");
    expect(r.raw).not.toContain("hunter2");
  });

  it("names the missing key variable when only the key is absent", async () => {
    const { get } = await boot({ env: { AI_PROVIDER: "openai", OPENAI_MODEL: "m" } });
    const r = await get("/api/config");
    expect(r.json.llm.ok).toBe(false);
    expect(r.json.llm.reason).toMatch(/OPENAI_API_KEY/);
  });

  it("reads .env under the root but the real environment wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "mockdata-server-env-"));
    writeFileSync(join(root, ".env"), "AI_PROVIDER=ollama\nOLLAMA_MODEL=from-file\n");
    const { get } = await boot({ root, env: { OLLAMA_MODEL: "from-env" } });
    expect((await get("/api/config")).json.llm.provider).toBe("ollama:from-env");
  });
});

describe("static files", () => {
  it("serves the built UI with a CSP and refuses to leave the directory", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "mockdata-static-"));
    writeFileSync(join(staticDir, "index.html"), "<h1>hi</h1>");
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "assets", "a.js"), "1");
    writeFileSync(join(staticDir, "..", "mockdata-secret.txt"), "secret");
    const { url, get } = await boot({ staticDir });
    const home = await get("/");
    expect(home.status).toBe(200);
    expect(home.raw).toContain("hi");
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(home.headers.get("x-frame-options")).toBe("DENY");
    expect((await get("/assets/a.js")).headers.get("content-type")).toContain("javascript");
    expect((await rawRequest(url, "/%2e%2e/mockdata-secret.txt", {})).status).toBe(404);
    expect((await rawRequest(url, "/..%2fmockdata-secret.txt", {})).status).toBe(404);
    expect((await get("/missing.js")).status).toBe(404);
  });

  it("serves the same page at /app and /docs, without becoming a catch-all", async () => {
    const staticDir = mkdtempSync(join(tmpdir(), "mockdata-static-"));
    writeFileSync(join(staticDir, "index.html"), "<h1>page</h1>");
    writeFileSync(join(staticDir, "f.woff2"), "w");
    const { get } = await boot({ staticDir });
    for (const p of ["/app", "/app/"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.raw).toContain("page");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
    expect((await get("/app/x.js")).status).toBe(404);
    for (const p of ["/docs", "/docs/", "/docs/schema", "/docs/quick-start/"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.raw).toContain("page");
    }
    for (const p of ["/docs/x.js", "/docs/a/b", "/docs/Schema"]) expect((await get(p)).status, p).toBe(404);
    expect((await get("/elsewhere")).status).toBe(404);
    expect((await get("/f.woff2")).headers.get("content-type")).toBe("font/woff2");
  });

  it("says the UI is not built when the directory is missing", async () => {
    const { get } = await boot({ staticDir: join(tmpdir(), "mockdata-does-not-exist") });
    const r = await get("/");
    expect(r.status).toBe(404);
    expect(r.raw).toMatch(/not been built/);
  });
});
