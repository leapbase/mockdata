import { describe, expect, it } from "vitest";
import { generate, parseSchema } from "../src/index.js";
import { ParentUsage } from "../src/generate.js";

/** The original behaviour: probe forward from `start`, wrapping, for the first parent with spare capacity. */
function bruteForce(counts: number[], start: number, poolSize: number, cap: number): number | undefined {
  for (let step = 0; step < poolSize; step++) {
    const idx = (start + step) % poolSize;
    if ((counts[idx] ?? 0) < cap) {
      counts[idx] = (counts[idx] ?? 0) + 1;
      return idx;
    }
  }
  return undefined;
}

describe("ParentUsage picks exactly the parent a linear probe would, without the probing", () => {
  it("matches the brute-force probe over many random fills, including a pool that grows (self references)", () => {
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const cap = 1 + rand(4);
      let pool = 1 + rand(30);
      const fast = new ParentUsage();
      const counts: number[] = [];
      for (let i = 0; i < 150; i++) {
        if (rand(5) === 0) pool += 1 + rand(3); // earlier rows accumulate
        const start = rand(pool) * (rand(3) === 0 ? 1 : 0) + (rand(2) ? 0 : Math.min(rand(3), pool - 1)); // clustered near 0, like zipf
        const s = Math.min(start, pool - 1);
        expect(fast.pick(s, pool, cap), `round ${round} pick ${i}`).toBe(bruteForce(counts, s, pool, cap));
      }
    }
  });

  it("does no bookkeeping when there is no cap", () => {
    const u = new ParentUsage();
    expect(u.pick(3, 10, Infinity)).toBe(3);
    expect(u.pick(3, 10, Infinity)).toBe(3);
  });
});

describe("generation time stays roughly linear in the number of rows", () => {
  it("fills a one-to-one foreign key under zipf skew in well under a second per 10k rows (it used to be quadratic)", () => {
    const n = 40_000;
    const schema = parseSchema({
      seed: 1,
      tables: {
        parents: { rows: n, columns: { id: { type: "integer", primaryKey: true } } },
        children: { rows: n, columns: { id: { type: "integer", primaryKey: true }, parent_id: { type: "integer", ref: "parents.id", distribution: "zipf", unique: true } } },
      },
    });
    const start = Date.now();
    const data = generate(schema, { seed: 1 });
    const took = Date.now() - start;
    expect(new Set(data.children!.map((r) => r.parent_id)).size).toBe(n); // still one-to-one
    expect(took).toBeLessThan(4000); // measured ~14 s before the fix
  });

  it("resolves cross-table date rules without scanning the parent table for every child row", () => {
    const schema = parseSchema({
      seed: 1,
      tables: {
        parents: { rows: 40_000, columns: { id: { type: "integer", primaryKey: true }, born: { type: "date", min: "2000-01-01", max: "2001-01-01" } } },
        children: {
          rows: 80_000,
          columns: { id: { type: "integer", primaryKey: true }, parent_id: { type: "integer", ref: "parents.id" }, at: { type: "date", min: "2000-01-01", after: "parent_id.born", within: 30 } },
        },
      },
    });
    const start = Date.now();
    const data = generate(schema, { seed: 1 });
    const took = Date.now() - start;
    const born = new Map(data.parents!.map((p) => [p.id, Date.parse(String(p.born))]));
    for (const c of data.children!.slice(0, 2000)) expect(Date.parse(String(c.at))).toBeGreaterThanOrEqual(born.get(c.parent_id)!);
    expect(took).toBeLessThan(6000);
  });
});
