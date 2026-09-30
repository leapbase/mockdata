import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@mockdata/llm";
import { boot } from "./helpers.js";

const NOTES = `seed: 3
llm: { provider: openai, model: m, batchSize: 2 }
tables:
  notes:
    rows: 5
    columns:
      id: { type: integer, primaryKey: true }
      body: { type: string, llm: true }
`;

function fake(delayMs = 0) {
  let calls = 0;
  let started!: () => void;
  const firstCall = new Promise<void>((r) => (started = r));
  const provider: LlmProvider = {
    name: "fake:m",
    async complete(req) {
      calls++;
      if (calls === 1) started();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
      return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `text ${calls}.${i}`)), usage: { inputTokens: 2, outputTokens: 3 } };
    },
  };
  return { provider, calls: () => calls, firstCall };
}

function events(raw: string): { event: string; data: any }[] {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)![1]!;
      const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]!);
      return { event, data };
    });
}

describe("POST /api/generate/stream", () => {
  it("streams progress and ends with the filled preview and report", async () => {
    const { provider } = fake();
    const { post } = await boot({ llm: { provider } });
    const r = await post("/api/generate/stream", { text: NOTES });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const ev = events(r.raw);
    expect(ev.filter((e) => e.event === "progress").map((e) => [e.data.done, e.data.total])).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
    const done = ev.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data.pending).toEqual([]);
    expect(done.data.tables.notes.rows.map((x: any) => x.body)).toEqual(["text 1.0", "text 1.1", "text 2.0", "text 2.1", "text 3.0"]);
    expect(done.data.report).toMatchObject({ calls: 3, inputTokens: 6, outputTokens: 9 });
  });

  it("reports a model failure as an error event", async () => {
    const provider: LlmProvider = {
      name: "bad",
      async complete() {
        return { text: "not json", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const { post } = await boot({ llm: { provider, sleep: async () => {} } });
    const ev = events((await post("/api/generate/stream", { text: NOTES })).raw);
    expect(ev.at(-1)!.event).toBe("error");
    expect(ev.at(-1)!.data.message).toMatch(/gave up/);
  });

  it("reports a missing provider as an error event", async () => {
    const { post } = await boot();
    const ev = events((await post("/api/generate/stream", { text: NOTES.replace(/^llm:.*\n/m, "") })).raw);
    expect(ev.at(-1)!.event).toBe("error");
    expect(ev.at(-1)!.data.message).toMatch(/AI_PROVIDER/);
  });

  it("rejects a bad schema with a plain JSON 400 before streaming", async () => {
    const { post } = await boot();
    const r = await post("/api/generate/stream", { text: "tables: 5" });
    expect(r.status).toBe(400);
    expect(r.json.error.name).toBe("SchemaError");
  });

  it("stops calling the model once the client disconnects", async () => {
    const { provider, calls, firstCall } = fake(150);
    const { url } = await boot({ llm: { provider } });
    const ac = new AbortController();
    const pending = fetch(`${url}/api/generate/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: NOTES }),
      signal: ac.signal,
    }).then(async (res) => res.text());
    await firstCall;
    ac.abort();
    await pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    expect(calls()).toBe(1);
  });
});
