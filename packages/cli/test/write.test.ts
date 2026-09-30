import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInside, UserError, writeFileConfined } from "../src/confined.js";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "mockdata-write-")));

describe("writeFileConfined (the write must re-check at write time)", () => {
  it("writes a new file, creating parent folders", () => {
    const root = tmp();
    writeFileConfined(root, resolveInside(root, "out/a.csv"), "hello");
    expect(readFileSync(join(root, "out/a.csv"), "utf8")).toBe("hello");
  });

  it("refuses a file that became a symlink after the earlier check, and leaves its target alone", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, "victim.txt"), "keep");
    const file = resolveInside(root, "a.csv"); // validated while nothing was there
    symlinkSync(join(outside, "victim.txt"), join(root, "a.csv")); // swapped in afterwards
    expect(() => writeFileConfined(root, file, "pwned", { overwrite: true })).toThrow(UserError);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("keep");
  });

  it("refuses a parent folder that became a symlink out of the root, and writes nothing there", () => {
    const root = tmp();
    const outside = tmp();
    const file = resolveInside(root, "out/a.csv");
    symlinkSync(outside, join(root, "out")); // swapped in afterwards
    expect(() => writeFileConfined(root, file, "pwned", { overwrite: true })).toThrow(UserError);
    expect(existsSync(join(outside, "a.csv"))).toBe(false);
  });

  it("does not truncate an existing file unless overwrite is set, and never follows a dangling link", () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(root, "a.csv"), "old");
    expect(() => writeFileConfined(root, join(root, "a.csv"), "new")).toThrow(/already exists/);
    expect(readFileSync(join(root, "a.csv"), "utf8")).toBe("old");
    writeFileConfined(root, join(root, "a.csv"), "new", { overwrite: true });
    expect(readFileSync(join(root, "a.csv"), "utf8")).toBe("new");
    symlinkSync(join(outside, "nothing.txt"), join(root, "dangling.csv"));
    expect(() => writeFileConfined(root, join(root, "dangling.csv"), "x", { overwrite: true })).toThrow(UserError);
    expect(existsSync(join(outside, "nothing.txt"))).toBe(false);
  });

  it("refuses a path outside the root", () => {
    const root = tmp();
    expect(() => writeFileConfined(root, join(tmp(), "a.csv"), "x")).toThrow(UserError);
  });
});
