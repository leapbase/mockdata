import { join } from "node:path";

/**
 * Point `@mockdata/*` at source so tests need no build. `repoRoot` is where this repo lives: its own root here, and
 * `vendor/mockdata` in a repo that embeds it, which reuses this list rather than copying it.
 */
export function mockdataAliases(repoRoot: string): Record<string, string> {
  const src = (pkg: string, entry = "index.ts") => join(repoRoot, "packages", pkg, "src", entry);
  return {
    "@mockdata/core": src("core"),
    "@mockdata/llm": src("llm"),
    "@mockdata/inputs": src("inputs"),
    "@mockdata/mcp": src("mcp"),
    "@mockdata/cli": src("cli", "cli.ts"),
  };
}
