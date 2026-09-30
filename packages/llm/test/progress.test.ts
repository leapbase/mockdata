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
