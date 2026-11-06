import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zip } from "../src/zip.js";

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

/** The entries of an archive, decompressed, in order. Parses the local headers (no external tool). */
function entriesOf(buf: Buffer): { name: string; data: Buffer }[] {
  const out: { name: string; data: Buffer }[] = [];
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const compressedSize = buf.readUInt32LE(p + 18);
    const size = buf.readUInt32LE(p + 22);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + compressedSize);
    expect(method).toBe(8);
    const data = inflateRawSync(raw);
    expect(data.length).toBe(size);
    out.push({ name, data });
    p = start + compressedSize;
  }
  expect(buf.readUInt32LE(p)).toBe(0x02014b50); // central directory follows
  return out;
}

describe("zip", () => {
  it("writes a well-formed archive with an end-of-central-directory record", () => {
    const buf = zip([
      { name: "a.csv", data: Buffer.from("id\n1\n") },
      { name: "b.csv", data: Buffer.from("") },
    ]);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = buf.length - 22;
    expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(buf.readUInt16LE(eocd + 10)).toBe(2);
  });

  it.skipIf(!hasUnzip)("is readable by unzip, byte for byte, including non-ASCII names", () => {
    const dir = mkdtempSync(join(tmpdir(), "mockdata-zip-"));
    const file = join(dir, "t.zip");
    const data = Buffer.from("héllo,wörld\n".repeat(50));
    writeFileSync(file, zip([{ name: "tëst.csv", data }, { name: "empty.csv", data: Buffer.alloc(0) }]));
    expect(spawnSync("unzip", ["-t", file]).status).toBe(0);
    // A wildcard selects the entry: macOS unzip does not match non-ASCII names given literally.
    expect(execFileSync("unzip", ["-p", file, "t*st.csv"])).toEqual(data);
  });

  it("deflates entries and round-trips byte-identical contents, including an empty file", () => {
    const text = "id,name,total\n1,Alice,42.50\n".repeat(200);
    const buf = zip([
      { name: "a.csv", data: text },
      { name: "b.csv", data: Buffer.from("") },
    ]);
    // Deflate shrinks repetitive text well below its stored size.
    expect(buf.length).toBeLessThan(text.length);
    expect(entriesOf(buf)).toEqual([
      { name: "a.csv", data: Buffer.from(text) },
      { name: "b.csv", data: Buffer.alloc(0) },
    ]);
    const eocd = buf.length - 22;
    expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(buf.readUInt16LE(eocd + 10)).toBe(2);
  });

  it("accepts a string or a Buffer with the same extracted bytes", () => {
    const data = "x,y\n1,2\n".repeat(20);
    expect(entriesOf(zip([{ name: "s.csv", data }]))).toEqual(entriesOf(zip([{ name: "s.csv", data: Buffer.from(data) }])));
  });
});
