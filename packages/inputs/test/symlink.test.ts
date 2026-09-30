import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferFromSource } from "../src/index.js";

describe("inferFromSource on a folder", () => {
  it("skips symlinked entries (they could point at .env or files outside the folder) and warns", async () => {
    const root = mkdtempSync(join(tmpdir(), "mockdata-symlink-"));
    const samples = join(root, "samples");
    mkdirSync(samples);
    writeFileSync(join(samples, "pets.csv"), "id,name\n1,Rex\n2,Fido\n");
    writeFileSync(join(root, "secret.csv"), "id,token\n1,TOPSECRET\n");
    symlinkSync(join(root, "secret.csv"), join(samples, "leak.csv"));

    const result = await inferFromSource(samples);
    expect(Object.keys(result.schema.tables)).toEqual(["pets"]);
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
    expect(result.warnings.join("\n")).toMatch(/symlink/i);
  });

  it("errors when the only sample files are symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "mockdata-symlink-"));
    const samples = join(root, "samples");
    mkdirSync(samples);
    writeFileSync(join(root, "secret.csv"), "id\n1\n");
    symlinkSync(join(root, "secret.csv"), join(samples, "leak.csv"));
    await expect(inferFromSource(samples)).rejects.toThrow(/No .csv/);
  });
});
