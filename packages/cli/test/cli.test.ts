import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type IO } from "../src/cli.js";

const example = join(__dirname, "../../../examples/shop.yaml");
const llmExample = join(__dirname, "../../../examples/shop-llm.yaml");

async function execWith(llm: IO["llm"], ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (s) => (out += s), err: (s) => (err += s), llm });
  return { code, out, err };
}
const exec = (...argv: string[]) => execWith(undefined, ...argv);

describe("cli", () => {
  it("validates a schema", async () => {
    expect(await exec("validate", example)).toMatchObject({ code: 0, out: "OK: 2 tables\n" });
  });

  it("prints JSON for all tables by default", async () => {
    const { code, out } = await exec("generate", example);
    const data = JSON.parse(out);
    expect(code).toBe(0);
    expect(data.customers).toHaveLength(20);
    expect(data.orders).toHaveLength(100);
  });

  it("writes one CSV per table with a header row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-"));
    expect((await exec("generate", example, "-o", dir, "-f", "csv")).code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["customers.csv", "orders.csv"]);
    const lines = readFileSync(join(dir, "orders.csv"), "utf8").trim().split("\n");
    expect(lines[0]).toBe("id,customer_id,placed_at,shipped_at,status,total");
    expect(lines).toHaveLength(101);
  });

  it("--seed changes the output and is reproducible", async () => {
    const a = (await exec("generate", example, "-s", "1")).out;
    expect((await exec("generate", example, "-s", "1")).out).toBe(a);
    expect((await exec("generate", example, "-s", "2")).out).not.toBe(a);
  });

  it("rejects bad input with a nonzero code", async () => {
    expect((await exec("generate")).code).toBe(1);
    expect((await exec("nope")).code).toBe(1);
    expect((await exec("generate", example, "-f", "xml")).code).toBe(1);
    expect((await exec("generate", example, "-f", "csv")).err).toMatch(/needs --out/);
    expect((await exec("generate", example, "-s", "abc")).code).toBe(1);
    expect((await exec("validate", "/no/such/file.yaml")).code).toBe(1);
  });
});

describe("cli with llm columns", () => {
  const provider = {
    name: "fake",
    async complete(req: { user: string }) {
      const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
      return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `great product ${i}`)), usage: { inputTokens: 100, outputTokens: 40 } };
    },
  };

  it("validate works without an API key", async () => {
    expect(await execWith({ env: {} }, "validate", llmExample)).toMatchObject({ code: 0, out: "OK: 2 tables\n" });
  });

  it("generate fills llm columns and reports token usage on stderr", async () => {
    const { code, out, err } = await execWith({ provider, sleep: async () => {} }, "generate", llmExample);
    expect(code).toBe(0);
    const data = JSON.parse(out);
    expect(data.reviews).toHaveLength(12);
    expect(data.reviews[0].body).toBe("great product 0");
    expect(err).toMatch(/llm: 1 call, 100 input \/ 40 output tokens; filled reviews\.body \(12 rows\)/);
  });

  it("generate names the missing environment variable instead of crashing", async () => {
    const { code, err } = await execWith({ env: {} }, "generate", llmExample);
    expect(code).toBe(1);
    expect(err).toMatch(/LlmConfigError: Missing API key: set the ANTHROPIC_API_KEY/);
  });
});
