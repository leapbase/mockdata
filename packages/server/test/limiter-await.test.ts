import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Rate limits, run slots and the hosted MCP hooks are async (they may live in Postgres). A call without `await` would
 * test a Promise, which is always truthy, and silently turn the limit off. Every call site must await.
 */
const SOURCES = [new URL("../src/", import.meta.url), new URL("../../mcp/src/", import.meta.url)];
const MUST_AWAIT = [
  /\blimiters\.\w+\.(?:hit|isLimited|retryAfterSeconds|record|reset)\(/g,
  /\.runs\.tryStart\(/g,
  /\bthrottle(?:Run|Validate)?\((?:ctx|acc)\b/g,
  /\bbefore(?:Validate|Infer)\(/g,
];

function files(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(new URL(`${e.name}/`, dir)) : e.name.endsWith(".ts") ? [join(dir.pathname, e.name)] : []));
}

/** Calls that are not directly awaited, skipping declarations (function, method or interface signatures). */
export function unawaited(source: string): string[] {
  const found: string[] = [];
  for (const re of MUST_AWAIT) {
    for (const m of source.matchAll(re)) {
      const before = source.slice(Math.max(0, m.index - 40), m.index);
      const line = source.slice(source.lastIndexOf("\n", m.index) + 1, source.indexOf("\n", m.index));
      // A declaration, not a call: `function name(`, a method body `name(args) {`, or an interface signature `name(args): T;`.
      const declaration = /\bfunction\s+\w+\(/.test(line) || /^\s*(async\s+)?before\w+\([^)]*\)\s*(\{|:)/.test(line);
      if (declaration || /\bawait\s+(hosted\??\.|[\w.]*)$/.test(before)) continue;
      found.push(line.trim());
    }
  }
  return found;
}

describe("async limits are always awaited", () => {
  it("finds no un-awaited limiter, run-slot, throttle or hook call in the server or the MCP server", () => {
    const misses = SOURCES.flatMap(files).flatMap((f) => unawaited(readFileSync(f, "utf8")).map((l) => `${f.split("/packages/")[1]}: ${l}`));
    expect(misses).toEqual([]);
  });

  it("catches a forgotten await", () => {
    expect(unawaited("if (!acc.limiters.loginIp.hit(ip)) throw x;")).toHaveLength(1);
    expect(unawaited("const release = accounts.runs.tryStart(user.id);")).toHaveLength(1);
    expect(unawaited("  throttleRun(ctx);")).toHaveLength(1);
    expect(unawaited("        hosted?.beforeValidate(schema);")).toHaveLength(1);
    expect(unawaited("if (!(await acc.limiters.loginIp.hit(ip))) throw x;")).toEqual([]);
    expect(unawaited("export async function throttleRun(ctx: Ctx): Promise<void> {")).toEqual([]);
  });
});
