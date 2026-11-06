import { describe, expect, it } from "vitest";
import { parseSchema, planGeneration, type Dataset } from "@mockdata/core";
import { fillLlmColumns, generateWithLlm, LlmCancelledError, LlmFillError, LlmHttpError, parseStringArray, type LlmProvider } from "../src/index.js";

const schema = (rows = 5, body: object = { type: "string", llm: { prompt: "a short product review" } }) => ({
  seed: 11,
  llm: { provider: "openai", model: "m" },
  tables: {
    products: { rows: 3, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string", faker: "commerce.productName" } } },
    reviews: {
      rows,
      columns: {
        id: { type: "integer", primaryKey: true },
        product_id: { type: "integer", ref: "products.id" },
        rating: { type: "integer", min: 1, max: 5 },
        body,
      },
    },
  },
});

/** Fake model: answers with `text(n, prompt, call)` and records every prompt. */
function fake(text: (n: number, prompt: string, call: number) => string | Error) {
  const prompts: string[] = [];
  const provider: LlmProvider = {
    name: "fake",
    async complete(req) {
      const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
      prompts.push(req.user);
      const out = text(n, req.user, prompts.length);
      if (out instanceof Error) throw out;
      return { text: out, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { provider, prompts };
}
const numbered = (n: number, start = 0) => JSON.stringify(Array.from({ length: n }, (_, i) => `review ${start + i}`));
const noSleep = async () => {};

describe("generateWithLlm", () => {
  it("fills llm columns while the deterministic ones depend only on the seed, not on model output", async () => {
    const { provider } = fake((n) => numbered(n));
    const { data, report } = await generateWithLlm(schema(), { provider, sleep: noSleep });
    const other = await generateWithLlm(schema(), { provider: fake((n) => numbered(n, 100)).provider, sleep: noSleep });
    const det = (d: typeof data) => d.reviews!.map((r) => [r.id, r.product_id, r.rating]);
    expect(det(data)).toEqual(det(other.data));
    expect(data.products).toEqual(other.data.products);
    expect(other.data.reviews![0]!.body).toBe("review 100");
    expect(data.reviews!.map((r) => r.body)).toEqual(["review 0", "review 1", "review 2", "review 3", "review 4"]);
    expect(report).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5, columns: { "reviews.body": 5 } });
  });

  it("puts the instruction and the row's other values in the prompt", async () => {
    const { provider, prompts } = fake((n) => numbered(n));
    const { data } = await generateWithLlm(schema(2), { provider, sleep: noSleep });
    expect(prompts[0]).toContain("Instruction: a short product review");
    expect(prompts[0]).toContain(`"rating":${data.reviews![0]!.rating}`);
  });

  it("splits large tables into batches", async () => {
    const { provider, prompts } = fake((n) => numbered(n));
    await generateWithLlm(schema(45), { provider, sleep: noSleep });
    expect(prompts).toHaveLength(3); // 20 + 20 + 5
  });

  it("tolerates a fenced reply", async () => {
    const { provider } = fake((n) => "```json\n" + numbered(n) + "\n```");
    const { data } = await generateWithLlm(schema(2), { provider, sleep: noSleep });
    expect(data.reviews![1]!.body).toBe("review 1");
  });

  it("retries rate limits and unusable replies, then succeeds", async () => {
    const { provider, prompts } = fake((n, _p, call) =>
      call === 1 ? new LlmHttpError("slow down", 429) : call === 2 ? "sorry, cannot" : call === 3 ? numbered(n + 1) : numbered(n),
    );
    const sleeps: number[] = [];
    const { data, report } = await generateWithLlm(schema(3), { provider, sleep: async (ms) => void sleeps.push(ms) });
    expect(prompts).toHaveLength(4);
    expect(report.calls).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(data.reviews!.every((r) => typeof r.body === "string")).toBe(true);
  });

  it("gives up with a clear error after the retry budget", async () => {
    const { provider } = fake(() => "nonsense");
    await expect(generateWithLlm(schema(3), { provider, sleep: noSleep })).rejects.toThrow(LlmFillError);
    await expect(generateWithLlm(schema(3), { provider, sleep: noSleep })).rejects.toThrow(/reviews\.body: gave up after 4 attempts/);
  });

  it("does not retry non-retryable errors such as bad credentials", async () => {
    const { provider, prompts } = fake(() => new LlmHttpError("unauthorized", 401));
    await expect(generateWithLlm(schema(3), { provider, sleep: noSleep })).rejects.toThrow(/unauthorized/);
    expect(prompts).toHaveLength(1);
  });

  it("re-asks for duplicates in a unique column, telling the model what to avoid", async () => {
    const { provider, prompts } = fake((n, prompt) =>
      prompt.includes("Do not reuse") ? JSON.stringify(Array.from({ length: n }, (_, i) => `fresh ${i}`)) : JSON.stringify(Array.from({ length: n }, (_, i) => (i < 2 ? `same ${i}` : "same 0"))),
    );
    const { data } = await generateWithLlm(schema(4, { type: "string", unique: true, llm: true }), { provider, sleep: noSleep });
    const bodies = data.reviews!.map((r) => r.body as string);
    expect(new Set(bodies).size).toBe(4);
    expect(prompts[1]).toContain("Do not reuse");
  });

  it("fails if a unique column cannot be made distinct", async () => {
    const { provider } = fake((n) => JSON.stringify(Array(n).fill("dup")));
    await expect(generateWithLlm(schema(3, { type: "string", unique: true, llm: true }), { provider, sleep: noSleep })).rejects.toThrow(/duplicated after 3 rounds/);
  });

  it("honours nullable: some cells stay null and are not sent to the model", async () => {
    const { provider, prompts } = fake((n) => numbered(n));
    const { data } = await generateWithLlm(schema(40, { type: "string", nullable: true, nullRate: 0.5, llm: true }), { provider, sleep: noSleep });
    const nulls = data.reviews!.filter((r) => r.body === null).length;
    expect(nulls).toBeGreaterThan(5);
    expect(nulls).toBeLessThan(35);
    const asked = Number(/exactly (\d+) strings/.exec(prompts[0]!)![1]) + (prompts[1] ? Number(/exactly (\d+) strings/.exec(prompts[1])![1]) : 0);
    expect(asked).toBe(40 - nulls);
  });

  it("makes no LLM calls (and needs no key) when no column uses llm", async () => {
    const s = schema(3, { type: "string" });
    delete (s as { llm?: unknown }).llm;
    const { data, report } = await generateWithLlm(s, { env: {} });
    expect(data.reviews).toHaveLength(3);
    expect(report.calls).toBe(0);
  });
});

describe("parseStringArray", () => {
  it("rejects non-arrays and non-string items", () => {
    expect(parseStringArray('{"a":1}')).toBeUndefined();
    expect(parseStringArray("[1,2]")).toBeUndefined();
    expect(parseStringArray('Sure! ["a","b"] Enjoy')).toEqual(["a", "b"]);
  });
});

describe("concurrent batches", () => {
  const big = (rows: number, batchSize: number) => ({
    seed: 11,
    llm: { provider: "openai", model: "m", batchSize },
    tables: {
      reviews: {
        rows,
        columns: {
          id: { type: "integer", primaryKey: true },
          body: { type: "string", llm: { prompt: "a review" } },
        },
      },
    },
  });

  /** Fake model that answers from the row ids in the prompt, so a value landing on the wrong row is visible. */
  function byId(delayMs: number, calls?: { max: number }) {
    let inFlight = 0;
    const provider: LlmProvider = {
      name: "fake",
      async complete(req) {
        inFlight++;
        if (calls) calls.max = Math.max(calls.max, inFlight);
        try {
          const ids = [...req.user.matchAll(/"id":(\d+)/g)].map((m) => m[1]);
          await new Promise((r) => setTimeout(r, delayMs));
          return { text: JSON.stringify(ids.map((id) => `row-${id}`)), usage: { inputTokens: 1, outputTokens: 1 } };
        } finally {
          inFlight--;
        }
      },
    };
    return provider;
  }

  it("runs batches concurrently and each value lands on the row it was requested for", async () => {
    const seen = { max: 0 };
    const { data, report } = await generateWithLlm(big(45, 5), { provider: byId(5, seen), sleep: noSleep });
    expect(seen.max).toBe(4); // 9 batches, default concurrency 4
    expect(report.calls).toBe(9);
    expect(data.reviews!.map((r) => r.body)).toEqual(data.reviews!.map((r) => `row-${r.id}`));
  });

  it("runs one batch at a time with concurrency 1", async () => {
    const seen = { max: 0 };
    const { data, report } = await generateWithLlm(big(12, 5), { provider: byId(5, seen), sleep: noSleep, concurrency: 1 });
    expect(seen.max).toBe(1);
    expect(report.calls).toBe(3);
    expect(data.reviews!.map((r) => r.body)).toEqual(data.reviews!.map((r) => `row-${r.id}`));
  });

  it("re-asks duplicates in a unique column across concurrent batches", async () => {
    const prompts: string[] = [];
    const provider: LlmProvider = {
      name: "fake",
      async complete(req) {
        prompts.push(req.user);
        const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
        await new Promise((r) => setTimeout(r, 2));
        if (req.user.includes("Do not reuse")) {
          const ids = [...req.user.matchAll(/"id":(\d+)/g)].map((m) => m[1]);
          return { text: JSON.stringify(ids.map((id) => `fresh-row-${id}`)), usage: { inputTokens: 1, outputTokens: 1 } };
        }
        return { text: JSON.stringify(Array(n).fill("dup")), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const s = big(8, 2);
    (s.tables.reviews.columns as Record<string, object>).body = { type: "string", unique: true, llm: true };
    const { data, report } = await generateWithLlm(s, { provider, sleep: noSleep });
    const bodies = data.reviews!.map((r) => r.body as string);
    expect(new Set(bodies).size).toBe(8); // exactly one "dup" survives round 1, the rest are re-asked fresh
    expect(bodies.filter((b) => b === "dup")).toHaveLength(1);
    expect(prompts.some((p) => p.includes("Do not reuse"))).toBe(true);
    expect(report.calls).toBe(8); // 4 batches in round 1, 4 in round 2 (7 re-asked rows)
  });

  it("abort stops new batches from starting while in-flight ones finish", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const provider: LlmProvider = {
      name: "fake",
      async complete(req) {
        calls++;
        const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
        const text = JSON.stringify(Array(n).fill("v"));
        if (calls === 1) return { text, usage: { inputTokens: 1, outputTokens: 1 } };
        await blocked; // later batches of the first wave stay in flight until released
        return { text, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ac = new AbortController();
    const run = generateWithLlm(big(45, 5), { provider, signal: ac.signal, sleep: noSleep, onProgress: () => ac.abort() });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(4); // the first wave only; abort prevents any further batch starting
    release();
    await expect(run).rejects.toBeInstanceOf(LlmCancelledError);
  });
});

describe("pre-parsed schema and plan", () => {
  it("generateWithLlm accepts an already-parsed schema and a precomputed plan, with identical output", async () => {
    const raw = schema(3);
    const parsed = parseSchema(raw);
    const plan = planGeneration(parsed);
    const { data } = await generateWithLlm(raw, { provider: fake((n) => numbered(n)).provider, sleep: noSleep });
    const { data: data2 } = await generateWithLlm(raw, { provider: fake((n) => numbered(n)).provider, sleep: noSleep, parsed, plan });
    expect(data2).toEqual(data);
  });

  it("fillLlmColumns with `parsed` does not re-parse the schema", async () => {
    const parsed = parseSchema(schema(2));
    // A strict re-parse would reject this unknown key; with `parsed` it is never re-parsed.
    (parsed as Record<string, unknown>).bogus = true;
    const data: Dataset = {
      products: [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
        { id: 3, name: "C" },
      ],
      reviews: [
        { id: 1, product_id: 1, rating: 3, body: undefined },
        { id: 2, product_id: 2, rating: 4, body: undefined },
      ],
    };
    const { provider } = fake((n) => numbered(n));
    await expect(fillLlmColumns(parsed, structuredClone(data), { provider, sleep: noSleep })).rejects.toThrow(/Unrecognized key/);
    const filled = structuredClone(data);
    await fillLlmColumns(parsed, filled, { provider, sleep: noSleep, parsed });
    expect(filled.reviews!.map((r) => r.body)).toEqual(["review 0", "review 1"]);
  });
});

describe("truncated replies", () => {
  const rowsOf = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `value ${i}`));

  /** Fake model that cuts its answer off (like hitting max_tokens) while the token limit is below `needs`. */
  function limited(needs: number, flag: boolean) {
    const limits: number[] = [];
    const provider: LlmProvider = {
      name: "fake",
      async complete(req) {
        limits.push(req.maxTokens);
        const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
        const full = rowsOf(n);
        if (req.maxTokens >= needs) return { text: full, usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: full.slice(0, Math.floor(full.length / 2)), usage: { inputTokens: 1, outputTokens: 1 }, ...(flag ? { truncated: true } : {}) };
      },
    };
    return { provider, limits };
  }

  it("gives a generous starting budget per row", async () => {
    const { provider, limits } = limited(0, true);
    await generateWithLlm(schema(12), { provider, sleep: noSleep });
    expect(limits).toEqual([256 + 12 * 150]);
  });

  it("doubles the token limit after a cut-off reply instead of repeating the same request", async () => {
    const { provider, limits } = limited(3000, true);
    const { data, report } = await generateWithLlm(schema(12), { provider, sleep: noSleep });
    expect(limits).toEqual([2056, 4112]);
    expect(report.calls).toBe(2);
    expect(data.reviews!.every((r) => typeof r.body === "string")).toBe(true);
  });

  it("notices truncation even when the provider does not report a stop reason", async () => {
    const { provider, limits } = limited(3000, false);
    await generateWithLlm(schema(12), { provider, sleep: noSleep });
    expect(limits).toEqual([2056, 4112]);
  });

  it("stops with advice to lower batchSize when even the maximum is not enough", async () => {
    const { provider, limits } = limited(1e9, true);
    await expect(generateWithLlm(schema(12), { provider, sleep: noSleep })).rejects.toThrow(/lower "llm\.batchSize"/);
    expect(limits[limits.length - 1]).toBe(8192);
    expect(limits.length).toBeLessThanOrEqual(4);
  });
});
