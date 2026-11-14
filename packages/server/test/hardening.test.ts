import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DataSchemaT } from "@mockdata/core";
import { parseAllow } from "@mockdata/cli";
import { jobTimeoutMs, MAX_JOB_TIMEOUT_MS, type PoolSettings } from "../src/workers/factory.js";
import { boot, SHOP_YAML, tmpRoot } from "./helpers.js";

describe("token redemption redirect", () => {
  it("never points at another site, whatever the path looks like", async () => {
    const TOKEN = "s3cret-token-0123456789";
    const { url } = await boot({ allow: parseAllow("100.100.1.x"), localHosts: [], token: TOKEN, trustLoopback: false });
    for (const path of ["/.//evil.example/x", "//evil.example/x", "/\\evil.example/x"]) {
      const r = await fetch(`${url}${path}?token=${TOKEN}`, { redirect: "manual" });
      const location = r.headers.get("location") ?? "";
      if (r.status === 302) {
        expect(location.startsWith("/"), path).toBe(true);
        expect(location.startsWith("//") || location.startsWith("/\\"), `${path} -> ${location}`).toBe(false);
      }
      expect(location).not.toContain(TOKEN);
    }
  });
});

describe("schema files", () => {
  it("removes folders a rename emptied, and refuses deeply nested names", async () => {
    const root = tmpRoot();
    const { put, post } = await boot({ root });
    expect((await put("/api/file", { path: "a/b/c/s.yaml", text: SHOP_YAML, create: true })).status).toBe(200);
    expect((await post("/api/file/rename", { from: "a/b/c/s.yaml", to: "x/s.yaml", text: SHOP_YAML })).status).toBe(200);
    expect(existsSync(join(root, "x", "s.yaml"))).toBe(true);
    expect(existsSync(join(root, "a"))).toBe(false);
    // A folder that still holds something stays.
    mkdirSync(join(root, "keep"));
    writeFileSync(join(root, "keep", "other.yaml"), SHOP_YAML);
    expect((await post("/api/file/rename", { from: "x/s.yaml", to: "keep/s.yaml", text: SHOP_YAML })).status).toBe(200);
    expect((await post("/api/file/rename", { from: "keep/s.yaml", to: "s.yaml", text: SHOP_YAML })).status).toBe(200);
    expect(existsSync(join(root, "keep", "other.yaml"))).toBe(true);
    expect(existsSync(join(root, "x"))).toBe(false);

    const deep = Array.from({ length: 12 }, (_, i) => `d${i}`).join("/") + "/s.yaml";
    const refused = await put("/api/file", { path: deep, text: SHOP_YAML, create: true });
    expect(refused.status).toBe(400);
    expect(refused.raw).toMatch(/nested too deeply/);
    expect(existsSync(join(root, "d0"))).toBe(false);
  });
});

describe("oversized or hostile schema text", () => {
  it("is refused by size before it is parsed", async () => {
    const { post } = await boot();
    const r = await post("/api/validate", { text: "# " + "x".repeat(2 * 1024 * 1024) + "\ntables: {}\n" });
    expect(JSON.stringify(r.json)).toMatch(/larger than 2 MB/);
  });

  it("answers a backtracking pattern and a megabyte-cell pattern with an error, quickly", async () => {
    const { post } = await boot();
    for (const pattern of ["a+a+a+a+a+a+a+a+a+a+a+a+a+a+\\\\d", "a{500000}"]) {
      const text = `tables:\n  t:\n    rows: 200\n    columns:\n      s: { type: string, pattern: "${pattern}" }\n`;
      const start = performance.now();
      const r = await post("/api/generate", { text, previewRows: 200 });
      expect(r.status, pattern).toBe(400);
      expect(r.raw, pattern).toMatch(/invalid pattern/);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  it("does not let infer read a file that is not a sample or schema document", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, ".env"), "ANTHROPIC_API_KEY=sk-ant-very-secret\n");
    writeFileSync(join(root, "deploy.env"), "STRIPE_API_KEY=sk_live_very_secret\n");
    const { post } = await boot({ root });
    for (const path of [".ENV", ".env", "deploy.env", "DEPLOY.ENV"]) {
      const r = await post("/api/infer", { path });
      expect(r.status, path).toBe(400);
      expect(r.raw, path).not.toMatch(/very.secret/);
    }
  });
});

describe("job time limit", () => {
  it("has a ceiling however small the schema makes its batches", () => {
    const settings: PoolSettings = { size: 2, maxQueue: 16, jobTimeoutSecs: 120, llmBatchSecs: 5, heapMb: 2048 };
    const schema: DataSchemaT = { llm: { batchSize: 1 }, tables: { notes: { rows: 1_000_000, columns: { id: { type: "integer", primaryKey: true }, body: { type: "string", llm: true } } } } };
    expect(jobTimeoutMs({ kind: "export", schema, format: "json", zip: true, env: {} }, settings)).toBe(MAX_JOB_TIMEOUT_MS);
    // An operator who allows longer jobs than the ceiling still gets what they asked for.
    expect(jobTimeoutMs({ kind: "export", schema, format: "json", zip: true, env: {} }, { ...settings, jobTimeoutSecs: 7200 })).toBe(7200 * 1000);
  });
});
