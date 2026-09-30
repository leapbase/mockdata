import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@mockdata/llm";
import { boot, SHOP_YAML, tmpRoot } from "./helpers.js";

describe("POST /api/export", () => {
  it("writes one file per table under the root", async () => {
    const root = tmpRoot();
    const { post } = await boot({ root });
    const r = await post("/api/export", { text: SHOP_YAML, format: "csv", outputDir: "out" });
    expect(r.status).toBe(200);
    expect(r.json.files.sort()).toEqual(["out/customers.csv", "out/orders.csv"]);
    expect(r.json.rows).toEqual({ customers: 6, orders: 15 });
    const csv = readFileSync(join(root, "out/orders.csv"), "utf8").split("\n");
    expect(csv[0]).toBe("id,customer_id,total");
    expect(csv).toHaveLength(15 + 2);
  });

  it("supports json and ndjson and honours the seed", async () => {
    const root = tmpRoot();
    const { post } = await boot({ root });
    await post("/api/export", { text: SHOP_YAML, seed: 5, outputDir: "a" });
    await post("/api/export", { text: SHOP_YAML, seed: 5, outputDir: "b", format: "ndjson" });
    const a = JSON.parse(readFileSync(join(root, "a/customers.json"), "utf8"));
    const b = readFileSync(join(root, "b/customers.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(a).toEqual(b);
  });

  it("refuses to overwrite unless asked, and checks before generating", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out/customers.json"), "keep");
    const { post } = await boot({ root });
    const r = await post("/api/export", { text: SHOP_YAML, outputDir: "out" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/Refusing to overwrite.*out\/customers\.json/);
    expect(readFileSync(join(root, "out/customers.json"), "utf8")).toBe("keep");
    expect(existsSync(join(root, "out/orders.json"))).toBe(false);
    expect((await post("/api/export", { text: SHOP_YAML, outputDir: "out", overwrite: true })).status).toBe(200);
  });

  it("does not spend LLM calls when the target already exists", async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: "f",
      async complete() {
        calls++;
        return { text: "[]", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const root = tmpRoot();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out/notes.json"), "keep");
    const { post } = await boot({ root, llm: { provider } });
    const text = "tables:\n  notes:\n    rows: 2\n    columns:\n      id: { type: integer, primaryKey: true }\n      b: { type: string, llm: true }\n";
    expect((await post("/api/export", { text, outputDir: "out" })).status).toBe(400);
    expect(calls).toBe(0);
  });

  it.each([["../escape"], ["/tmp/abs"]])("refuses outputDir %s", async (outputDir) => {
    const { post } = await boot({ root: tmpRoot() });
    const r = await post("/api/export", { text: SHOP_YAML, outputDir });
    expect(r.status).toBe(400);
  });

  it("needs exactly one of outputDir and zip", async () => {
    const { post } = await boot();
    expect((await post("/api/export", { text: SHOP_YAML })).status).toBe(400);
    expect((await post("/api/export", { text: SHOP_YAML, outputDir: "o", zip: true })).status).toBe(400);
  });

  it("rejects an unknown format", async () => {
    const { post } = await boot();
    expect((await post("/api/export", { text: SHOP_YAML, outputDir: "o", format: "xml" })).status).toBe(400);
  });

  it("returns a zip without writing anything", async () => {
    const root = tmpRoot();
    const { url } = await boot({ root });
    const res = await fetch(`${url}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SHOP_YAML, zip: true, format: "csv" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("mockdata.zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(buf.length - 22 + 10)).toBe(2);
    expect(readdirSync(root)).toEqual([]);
  });
});
