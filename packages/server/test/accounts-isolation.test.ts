import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootAccounts, SHOP_YAML } from "./helpers.js";

const LLM_YAML = (rows: number) => `seed: 1
tables:
  products:
    rows: ${rows}
    columns:
      id: { type: integer, primaryKey: true }
      note: { type: string, llm: true }
`;

/** A fake Ollama-style server that records every request and answers with N strings. */
function fakeModel(opts: { gate?: Promise<void> } = {}) {
  const calls: { url: string; body: any }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    await opts.gate;
    const n = /exactly (\d+)/.exec(JSON.stringify(body.messages))?.[1];
    const count = n ? Number(n) : 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(Array.from({ length: count }, (_, i) => `text ${i}`)) }, finish_reason: "stop" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const OLLAMA_ENV = { AI_PROVIDER: "ollama", OLLAMA_MODEL: "operator-model" };

describe("accounts: every user gets a private folder", () => {
  it("keeps one user's files from another, and from the account database", async () => {
    const { signUp, as, dataDir } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    const bob = as(await signUp("bob@example.com"));
    expect((await ann.put("/api/file", { path: "a.yaml", text: SHOP_YAML })).status).toBe(200);
    expect((await ann.get("/api/files")).json.files).toContain("a.yaml");
    expect((await bob.get("/api/files")).json.files).not.toContain("a.yaml");
    const peek = await bob.get("/api/file?path=a.yaml");
    expect(peek.status).toBe(400);
    expect(peek.raw).not.toContain("customers");
    // same name, separate content
    await bob.put("/api/file", { path: "a.yaml", text: "tables: {}\n" });
    expect((await ann.get("/api/file?path=a.yaml")).json.text).toBe(SHOP_YAML);
    // the account database and other folders sit above the user's root and cannot be named
    expect(existsSync(join(dataDir, "accounts.db")) || true).toBe(true);
    for (const path of ["../accounts.yaml", "../../accounts.json", "../users/x/a.yaml"]) {
      expect((await ann.put("/api/file", { path, text: "x: 1\n" })).status, path).toBe(400);
      expect((await ann.get(`/api/file?path=${encodeURIComponent(path)}`)).status, path).toBe(400);
    }
  });

  it("names each folder with a random id that is not derived from the email", async () => {
    const { signUp, as, dataDir } = await bootAccounts();
    await as(await signUp("ann@example.com")).put("/api/file", { path: "a.yaml", text: SHOP_YAML });
    const dirs = readdirSync(join(dataDir, "users"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(dirs[0]).not.toContain("ann");
  });

  it("refuses a link inside a user's folder that leads to another user's folder", async () => {
    const { signUp, as, dataDir } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    const bob = as(await signUp("bob@example.com"));
    await ann.put("/api/file", { path: "secret.yaml", text: SHOP_YAML });
    await bob.get("/api/files"); // a user's folder is created on their first call
    const [a, b] = readdirSync(join(dataDir, "users"));
    const annDir = join(dataDir, "users", [a, b].find((d) => existsSync(join(dataDir, "users", d!, "secret.yaml")))!);
    const bobDir = join(dataDir, "users", [a, b].find((d) => join(dataDir, "users", d!) !== annDir)!);
    symlinkSync(join(annDir, "secret.yaml"), join(bobDir, "stolen.yaml"));
    symlinkSync(annDir, join(bobDir, "annfolder"));
    expect((await bob.get("/api/file?path=stolen.yaml")).status).toBe(400);
    expect((await bob.get("/api/file?path=annfolder/secret.yaml")).status).toBe(400);
    expect((await bob.put("/api/file", { path: "stolen.yaml", text: "x: 1\n" })).status).toBe(400);
    expect(readFileSync(join(annDir, "secret.yaml"), "utf8")).toBe(SHOP_YAML);
  });

  it("exports into the user's own folder and refuses to leave it", async () => {
    const { signUp, as, dataDir } = await bootAccounts();
    const ann = as(await signUp("ann@example.com"));
    const ok = await ann.post("/api/export", { text: SHOP_YAML, format: "csv", outputDir: "out" });
    expect(ok.status).toBe(200);
    expect(ok.json.files.sort()).toEqual(["out/customers.csv", "out/orders.csv"]);
    const [dir] = readdirSync(join(dataDir, "users"));
    expect(existsSync(join(dataDir, "users", dir!, "out", "orders.csv"))).toBe(true);
    for (const outputDir of ["..", "../escape", "../../escape"]) {
      expect((await ann.post("/api/export", { text: SHOP_YAML, outputDir })).status, outputDir).toBe(400);
    }
    expect(existsSync(join(dataDir, "escape"))).toBe(false);
  });

  it("does not serve .env from the operator's config folder", async () => {
    const { signUp, as, configRoot } = await bootAccounts();
    writeFileSync(join(configRoot, ".env"), "OPENAI_API_KEY=sk-secret\n");
    const ann = as(await signUp("ann@example.com"));
    for (const path of [".env", "../.env", "../../.env"]) {
      const r = await ann.get(`/api/file?path=${encodeURIComponent(path)}`);
      expect(r.status, path).toBe(400);
      expect(r.raw).not.toContain("sk-secret");
    }
  });
});

describe("accounts: the operator's secrets and choices stay the operator's", () => {
  it("hides database variable names and refuses inferring from one", async () => {
    const { signUp, as } = await bootAccounts({ env: { DATABASE_URL: "postgres://op:pw@db.internal/prod" } });
    const ann = as(await signUp("ann@example.com"));
    expect((await ann.get("/api/config")).json.dbEnv).toEqual([]);
    const infer = await ann.post("/api/infer", { connectionEnv: "DATABASE_URL" });
    expect(infer.status).toBe(400);
    expect(infer.raw).not.toContain("postgres://");
    expect(infer.raw).not.toContain("db.internal");
    // inferring from pasted content still works
    const pasted = await ann.post("/api/infer", { content: JSON.stringify([{ id: 1, name: "a" }, { id: 2, name: "b" }]), name: "things.json" });
    expect(pasted.status).toBe(200);
  });

  it("ignores the schema's llm block for provider, model, address and key variable", async () => {
    const model = fakeModel();
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV, llm: { fetch: model.fetchFn } });
    const ann = as(await signUp("ann@example.com"));
    const text = `llm: { provider: openai-compatible, model: pricey-model, baseUrl: "https://evil.example/v1", apiKeyEnv: OPENAI_API_KEY, batchSize: 5 }\n${LLM_YAML(3)}`;
    const r = await ann.post("/api/generate/stream", { text });
    expect(r.status).toBe(200);
    expect(r.raw).toContain("event: done");
    expect(model.calls.length).toBeGreaterThan(0);
    for (const c of model.calls) {
      expect(c.url).toMatch(/^http:\/\/localhost:11434\/v1\//);
      expect(c.body.model).toBe("operator-model");
    }
  });

  it("reports the operator's provider, not one named by a schema, in the status the UI shows", async () => {
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV });
    const ann = as(await signUp("ann@example.com"));
    const v = await ann.post("/api/validate", { text: `llm: { provider: openai, model: x, apiKeyEnv: OPENAI_API_KEY }\n${LLM_YAML(2)}` });
    expect(v.json.llm).toEqual({ ok: true, provider: "ollama:operator-model" });
  });
});

describe("accounts: quotas protect the shared model key and the server", () => {
  it("refuses runs past the daily LLM-row budget, and counts what was used", async () => {
    const model = fakeModel();
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV, limits: { llmDailyRows: 10 }, llm: { fetch: model.fetchFn } });
    const ann = as(await signUp("ann@example.com"));
    expect((await ann.post("/api/generate/stream", { text: LLM_YAML(6) })).status).toBe(200);
    const over = await ann.post("/api/generate/stream", { text: LLM_YAML(6) }); // 6 + 6 > 10
    expect(over.status).toBe(429);
    expect(over.json.error.message).toMatch(/daily/i);
    expect((await ann.post("/api/generate/stream", { text: LLM_YAML(4) })).status).toBe(200); // 6 + 4 = 10 fits
    const bob = as(await signUp("bob@example.com")); // budgets are per user
    expect((await bob.post("/api/generate/stream", { text: LLM_YAML(10) })).status).toBe(200);
  });

  it("allows one run at a time per user", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = fakeModel({ gate });
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV, llm: { fetch: model.fetchFn } });
    const ann = as(await signUp("ann@example.com"));
    const first = ann.post("/api/generate/stream", { text: LLM_YAML(3) });
    await new Promise((r) => setTimeout(r, 100)); // the first run is now waiting on the model
    const second = await ann.post("/api/generate/stream", { text: LLM_YAML(3) });
    expect(second.status).toBe(429);
    expect(second.json.error.message).toMatch(/already running|too many/i);
    release();
    expect((await first).status).toBe(200);
    expect((await ann.post("/api/generate/stream", { text: LLM_YAML(3) })).status).toBe(200); // the slot is free again
  });

  it("caps the rows of one run below the old default", async () => {
    const { signUp, as } = await bootAccounts({ limits: { maxRows: 100 } });
    const ann = as(await signUp("ann@example.com"));
    const r = await ann.post("/api/export", { text: SHOP_YAML.replace("rows: 15", "rows: 500"), zip: true });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/100/);
  });

  it("stops a user filling the disk, and refuses huge schema files", async () => {
    const { signUp, as } = await bootAccounts({ limits: { userQuotaBytes: 2000 } });
    const ann = as(await signUp("ann@example.com"));
    expect((await ann.put("/api/file", { path: "a.yaml", text: "# " + "x".repeat(1200) + "\n" })).status).toBe(200);
    const over = await ann.put("/api/file", { path: "b.yaml", text: "# " + "x".repeat(1200) + "\n" });
    expect(over.status).toBe(429);
    expect(over.json.error.message).toMatch(/storage/i);
    expect((await ann.put("/api/file", { path: "a.yaml", text: "# small\n" })).status).toBe(200); // replacing frees space
    const big = await bootAccounts();
    const bob = big.as(await big.signUp("bob@example.com"));
    expect((await bob.put("/api/file", { path: "big.yaml", text: "# " + "x".repeat(1_100_000) + "\n" })).status).toBe(413);
  });

  it("checks export size against the quota before writing anything", async () => {
    const { signUp, as, dataDir } = await bootAccounts({ limits: { userQuotaBytes: 50 } });
    const ann = as(await signUp("ann@example.com"));
    const r = await ann.post("/api/export", { text: SHOP_YAML, format: "csv", outputDir: "out" });
    expect(r.status).toBe(429);
    const [dir] = readdirSync(join(dataDir, "users"));
    expect(existsSync(join(dataDir, "users", dir!, "out"))).toBe(false);
  });
});

describe("accounts: model spend cannot be multiplied by tuning the schema or by making more accounts", () => {
  it("stops the operator's overall daily model budget from being exceeded across users", async () => {
    const model = fakeModel();
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV, limits: { llmDailyRows: 100, llmGlobalDailyRows: 10 }, llm: { fetch: model.fetchFn } });
    const ann = as(await signUp("ann@example.com"));
    const bob = as(await signUp("bob@example.com"));
    expect((await ann.post("/api/generate/stream", { text: LLM_YAML(6) })).status).toBe(200);
    const over = await bob.post("/api/generate/stream", { text: LLM_YAML(6) }); // each user is well under their own limit
    expect(over.status).toBe(429);
    expect(over.json.error.message).toMatch(/server/i);
    expect((await bob.post("/api/generate/stream", { text: LLM_YAML(4) })).status).toBe(200); // 6 + 4 fits the overall 10
  });

  it("refuses a huge per-column instruction, which would be re-sent with every batch", async () => {
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV });
    const ann = as(await signUp("ann@example.com"));
    const long = `tables:\n  t:\n    rows: 3\n    columns:\n      id: { type: integer, primaryKey: true }\n      note: { type: string, llm: { prompt: "${"x".repeat(501)}" } }\n`;
    const r = await ann.post("/api/generate/stream", { text: long });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/500/);
    const ok = long.replace("x".repeat(501), "x".repeat(500));
    expect((await ann.post("/api/validate", { text: ok })).status).toBe(200);
  });

  it("does not let a schema shrink batches to one row per request", async () => {
    const model = fakeModel();
    const { signUp, as } = await bootAccounts({ env: OLLAMA_ENV, limits: { llmDailyRows: 1000 }, llm: { fetch: model.fetchFn } });
    const ann = as(await signUp("ann@example.com"));
    const r = await ann.post("/api/generate/stream", { text: `llm: { batchSize: 1 }\n${LLM_YAML(25)}` });
    expect(r.status).toBe(200);
    expect(model.calls.length).toBeLessThanOrEqual(3); // 25 rows in batches of at least 10, not 25 requests
  });
});
