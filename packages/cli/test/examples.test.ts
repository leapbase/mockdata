import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

// The README documents these files; this keeps every one of them working.
const examples = join(__dirname, "../../../examples");
const empty = mkdtempSync(join(tmpdir(), "mockdata-examples-cwd-"));

async function exec(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (s) => (out += s), err: (s) => (err += s), llm: { env: {} }, cwd: empty });
  return { code, out, err };
}
const json = async (...argv: string[]) => {
  const r = await exec(...argv);
  expect(r.code, r.err).toBe(0);
  return JSON.parse(r.out);
};

describe("every example schema validates", () => {
  const files = readdirSync(examples).filter((f) => f.endsWith(".yaml") && f !== "petstore-openapi.yaml");
  it.each(files)("%s", async (file) => {
    const r = await exec("validate", join(examples, file));
    expect(r.code, r.err).toBe(0);
  });
});

describe("shop.yaml", () => {
  it("generates the documented row counts", async () => {
    const data = await json("generate", join(examples, "shop.yaml"));
    expect(Object.fromEntries(Object.entries(data).map(([t, r]) => [t, (r as unknown[]).length]))).toEqual({ customers: 20, orders: 100 });
  });
});

describe("hr.yaml", () => {
  it("produces data that satisfies every feature it demonstrates", async () => {
    const d = await json("generate", join(examples, "hr.yaml"));
    const employees: Record<string, any>[] = d.employees;
    const ids = new Set(employees.map((e) => e.id));

    // cycle broken through the nullable foreign key, and filled afterwards
    for (const dep of d.departments) expect(ids.has(dep.head_id)).toBe(true);
    // patterns
    for (const dep of d.departments) expect(dep.code).toMatch(/^D[0-9]{3}$/);
    for (const e of employees) expect(e.badge).toMatch(/^EMP-[0-9]{5}$/);
    // self reference points at an earlier employee
    employees.forEach((e, i) => e.manager_id !== null && expect(e.manager_id).toBeLessThanOrEqual(i));
    // cross-column rule
    for (const e of employees) if (e.left_on) expect(e.left_on >= e.hired_on).toBe(true);
    // one-to-one
    const parked = d.parking_spots.map((p: any) => p.employee_id);
    expect(new Set(parked).size).toBe(parked.length);
    // per-parent cap
    const counts = new Map<number, number>();
    for (const q of d.equipment) counts.set(q.employee_id, (counts.get(q.employee_id) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });
});

describe("infer examples", () => {
  it("examples/samples: recovers the relationship and the date rules from the CSVs", async () => {
    const r = await exec("infer", join(examples, "samples"));
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/ref: customers\.id/);
    expect(r.out).toMatch(/after: customer_id\.signup_date/);
    expect(r.out).toMatch(/after: placed_at/);
  });

  it("petstore-openapi.yaml: three tables linked by owner_id and pet_id, Visit has 200 rows", async () => {
    const r = await exec("infer", join(examples, "petstore-openapi.yaml"), "--rows", "10");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/ref: Owner\.id/);
    expect(r.out).toMatch(/ref: Pet\.id/);
    expect(r.out).toMatch(/rows: 200/); // x-rows on Visit wins over --rows
  });

  it("make-sample-db.mjs: builds a database that infers into linked tables", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mockdata-sampledb-")), "sample.db");
    execFileSync(process.execPath, [join(examples, "make-sample-db.mjs"), db]);
    const r = await exec("infer", db);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/order_id:\n\s+type: integer\n\s+ref: orders\.id/);
    expect(r.err).toMatch(/employees\.manager_id: self-referencing foreign key made nullable/);
    expect(r.out).not.toContain("demo@example.com"); // structure only, never rows
  });
});
