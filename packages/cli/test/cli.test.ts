import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

const example = join(__dirname, "../../../examples/shop.yaml");

function exec(...argv: string[]) {
  let out = "";
  let err = "";
  const code = run(argv, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

describe("cli", () => {
  it("validates a schema", () => {
    expect(exec("validate", example)).toMatchObject({ code: 0, out: "OK: 2 tables\n" });
  });

  it("prints JSON for all tables by default", () => {
    const { code, out } = exec("generate", example);
    const data = JSON.parse(out);
    expect(code).toBe(0);
    expect(data.customers).toHaveLength(20);
    expect(data.orders).toHaveLength(100);
  });

  it("writes one CSV per table with a header row", () => {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-"));
    expect(exec("generate", example, "-o", dir, "-f", "csv").code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(["customers.csv", "orders.csv"]);
    const lines = readFileSync(join(dir, "orders.csv"), "utf8").trim().split("\n");
    expect(lines[0]).toBe("id,customer_id,placed_at,shipped_at,status,total");
    expect(lines).toHaveLength(101);
  });

  it("--seed changes the output and is reproducible", () => {
    const a = exec("generate", example, "-s", "1").out;
    expect(exec("generate", example, "-s", "1").out).toBe(a);
    expect(exec("generate", example, "-s", "2").out).not.toBe(a);
  });

  it("rejects bad input with a nonzero code", () => {
    expect(exec("generate").code).toBe(1);
    expect(exec("nope").code).toBe(1);
    expect(exec("generate", example, "-f", "xml").code).toBe(1);
    expect(exec("generate", example, "-f", "csv").err).toMatch(/needs --out/);
    expect(exec("generate", example, "-s", "abc").code).toBe(1);
    expect(exec("validate", "/no/such/file.yaml").code).toBe(1);
  });
});
