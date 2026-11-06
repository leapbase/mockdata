import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseSchema } from "@mockdata/core";
import type { LlmProvider } from "@mockdata/llm";
import { runJob } from "../src/workers/job.js";

/** Entries of a zip archive, decompressed, in order (parses the local headers; no external tool). */
function entriesOf(buf: Buffer): { name: string; data: string }[] {
  const out: { name: string; data: string }[] = [];
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    expect(buf.readUInt16LE(p + 8)).toBe(8); // deflate
    const compressedSize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    out.push({ name, data: inflateRawSync(buf.subarray(start, start + compressedSize)).toString("utf8") });
    p = start + compressedSize;
  }
  return out;
}

const BIG = parseSchema({
  seed: 7,
  tables: {
    customers: {
      rows: 100_000,
      columns: {
        id: { type: "integer", primaryKey: true },
        name: { type: "string", faker: "person.fullName" },
      },
    },
    orders: {
      rows: 100_000,
      columns: {
        id: { type: "integer", primaryKey: true },
        customer_id: { type: "integer", ref: "customers.id" },
        total: { type: "float", min: 1, max: 9 },
      },
    },
  },
});

/** A provider that answers every batch with one distinct value per requested row. */
const fakeProvider: LlmProvider = {
  name: "fake",
  async complete(req) {
    const n = Number(/exactly (\d+) strings/.exec(req.user)?.[1] ?? 0);
    return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `value ${i}`)), usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

describe("runJob preview subset (PERF-H4)", () => {
  it("generates only the preview rows of a 100k-row schema, but reports the full counts", async () => {
    const started = Date.now();
    const { preview } = await runJob({ kind: "preview", schema: BIG, seed: 7, previewRows: 5 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(preview.counts).toEqual({ customers: 100_000, orders: 100_000 });
    expect(preview.tables.customers!.rows).toHaveLength(5);
    expect(preview.tables.orders!.rows).toHaveLength(5);
    // Foreign keys resolve inside the generated subset, not against rows that were never generated.
    const ids = new Set(preview.tables.customers!.rows.map((r) => r.id));
    expect(ids.size).toBe(5);
    for (const row of preview.tables.orders!.rows) expect(ids.has(row.customer_id)).toBe(true);
  });

  it("is deterministic for a given seed/schema/previewRows, and keeps tables smaller than previewRows", async () => {
    const a = await runJob({ kind: "preview", schema: BIG, seed: 7, previewRows: 5 });
    const b = await runJob({ kind: "preview", schema: BIG, seed: 7, previewRows: 5 });
    expect(a.preview).toEqual(b.preview);
    const small = parseSchema({
      tables: { t: { rows: 3, columns: { id: { type: "integer", primaryKey: true } } } },
    });
    const { preview } = await runJob({ kind: "preview", schema: small, previewRows: 50 });
    expect(preview.counts).toEqual({ t: 3 });
    expect(preview.tables.t!.rows).toHaveLength(3);
  });

  it("fills only the preview rows of llm columns on a run job", async () => {
    const schema = parseSchema({
      llm: { provider: "openai", model: "m" },
      tables: {
        notes: {
          rows: 200,
          columns: {
            id: { type: "integer", primaryKey: true },
            body: { type: "string", llm: true },
          },
        },
      },
    });
    const { preview, report } = await runJob(
      { kind: "run", schema, seed: 1, previewRows: 5, env: {} },
      { llm: { provider: fakeProvider } },
    );
    expect(preview.counts).toEqual({ notes: 200 });
    expect(preview.tables.notes!.rows).toHaveLength(5);
    expect(preview.pending).toEqual([]);
    expect(report.columns).toEqual({ "notes.body": 5 });
    expect(report.calls).toBe(1);
  });
});

describe("runJob sample subset (PERF-H4)", () => {
  const schema = parseSchema({
    seed: 3,
    tables: {
      t: {
        rows: 100,
        columns: { id: { type: "integer", primaryKey: true }, v: { type: "string" } },
      },
    },
  });

  it("returns full counts with only sampleRows rows when no format is asked for", async () => {
    const { counts, sample } = await runJob({ kind: "sample", schema, sampleRows: 3, env: {} });
    expect(counts).toEqual({ t: 100 });
    expect(sample.t).toHaveLength(3);
  });

  it("still generates the full dataset when a format is asked for, so the texts are complete", async () => {
    const { counts, sample, texts } = await runJob({ kind: "sample", schema, sampleRows: 3, format: "json", env: {} });
    expect(counts).toEqual({ t: 100 });
    expect(sample.t).toHaveLength(3);
    expect(JSON.parse(texts!.t!)).toHaveLength(100);
  });
});

describe("runJob export zip (PERF-M6)", () => {
  it("extracts byte-identical to the plain-text export for the same seed/schema", async () => {
    const schema = parseSchema({
      seed: 7,
      tables: {
        customers: {
          rows: 6,
          columns: {
            id: { type: "integer", primaryKey: true },
            name: { type: "string", faker: "person.fullName" },
          },
        },
        orders: {
          rows: 15,
          columns: {
            id: { type: "integer", primaryKey: true },
            customer_id: { type: "integer", ref: "customers.id" },
            total: { type: "float", min: 1, max: 9 },
          },
        },
      },
    });
    const plain = await runJob({ kind: "export", schema, seed: 7, format: "csv", zip: false, env: {} });
    const zipped = await runJob({ kind: "export", schema, seed: 7, format: "csv", zip: true, env: {} });
    expect(zipped.counts).toEqual(plain.counts);
    expect(entriesOf(Buffer.from(zipped.archive!))).toEqual([
      { name: "customers.csv", data: plain.texts!.customers! },
      { name: "orders.csv", data: plain.texts!.orders! },
    ]);
  });
});
