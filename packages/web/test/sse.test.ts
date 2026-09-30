import { describe, expect, it } from "vitest";
import { readSse } from "../src/sse";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}
async function all(body: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const e of readSse(body)) out.push(e);
  return out;
}

describe("readSse", () => {
  it("parses events split across arbitrary chunk boundaries", async () => {
    const wire = 'event: progress\ndata: {"done":1}\n\nevent: done\ndata: {"ok":true}\n\n';
    for (const size of [1, 3, 7, wire.length]) {
      const chunks = wire.match(new RegExp(`.{1,${size}}`, "gs"))!;
      expect(await all(stream(chunks))).toEqual([
        { event: "progress", data: { done: 1 } },
        { event: "done", data: { ok: true } },
      ]);
    }
  });
  it("does not split a multi-byte character across chunks", async () => {
    const bytes = new TextEncoder().encode('event: e\ndata: {"t":"héllo ✓"}\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    });
    expect(await all(body)).toEqual([{ event: "e", data: { t: "héllo ✓" } }]);
  });
  it("ignores an incomplete trailing event", async () => {
    expect(await all(stream(['event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y"']))).toEqual([{ event: "a", data: { x: 1 } }]);
  });
});
