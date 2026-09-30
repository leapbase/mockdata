import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zip } from "../src/zip.js";

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

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
});
