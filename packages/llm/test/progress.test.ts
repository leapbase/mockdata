import { describe, expect, it } from "vitest";
import { generateWithLlm, LlmCancelledError, type LlmProgress, type LlmProvider } from "../src/index.js";

const schema = {
  seed: 3,
  llm: { provider: "openai", model: "m", batchSize: 2 },
  tables: {
    notes: { rows: 5, columns: { id: { type: "integer", primaryKey: true }, body: { type: "string", llm: true } } },
  },
};

function fake() {
  let calls = 0;
  const provider: LlmProvider = {
    name: "fake",
    async complete(req) {
      calls++;
      const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
      return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `v${calls}-${i}`)), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { provider, calls: () => calls };
}

describe("progress and cancellation", () => {
  it("reports progress after every batch", async () => {
    const seen: LlmProgress[] = [];
    await generateWithLlm(schema, { provider: fake().provider, onProgress: (e) => seen.push(e) });
    expect(seen.map((e) => [e.column, e.done, e.total])).toEqual([
      ["notes.body", 2, 5],
      ["notes.body", 4, 5],
      ["notes.body", 5, 5],
    ]);
    expect(seen.at(-1)).toMatchObject({ calls: 3, inputTokens: 3, outputTokens: 3 });
  });

  it("stops before the next request once the signal is aborted", async () => {
    const ac = new AbortController();
    const { provider, calls } = fake();
    await expect(generateWithLlm(schema, { provider, signal: ac.signal, onProgress: () => ac.abort() })).rejects.toBeInstanceOf(LlmCancelledError);
    expect(calls()).toBe(1);
  });

  it("does not call the model at all if already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, calls } = fake();
    await expect(generateWithLlm(schema, { provider, signal: ac.signal })).rejects.toBeInstanceOf(LlmCancelledError);
    expect(calls()).toBe(0);
  });
});

describe("cancellation during retries", () => {
  it("does not retry after the signal is aborted mid-batch", async () => {
    const ac = new AbortController();
    let calls = 0;
    const provider: LlmProvider = {
      name: "flaky",
      async complete() {
        calls++;
        ac.abort();
        return { text: "not json", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await expect(generateWithLlm(schema, { provider, signal: ac.signal, sleep: async () => {} })).rejects.toBeInstanceOf(LlmCancelledError);
    expect(calls).toBe(1);
  });

  it("wakes from a backoff sleep as soon as the signal is aborted", async () => {
    const ac = new AbortController();
    const provider: LlmProvider = {
      name: "flaky",
      async complete() {
        return { text: "not json", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const started = Date.now();
    const run = generateWithLlm(schema, { provider, signal: ac.signal, sleep: () => new Promise((r) => setTimeout(r, 5000)) });
    setTimeout(() => ac.abort(), 50);
    await expect(run).rejects.toBeInstanceOf(LlmCancelledError);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
