import { describe, expect, it } from "vitest";
import { generateWithLlm, LlmFillError, LlmHttpError, parseStringArray, type LlmProvider } from "../src/index.js";

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
