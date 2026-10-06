import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dist = new URL("../dist/", import.meta.url);
const manifestFile = new URL(".vite/manifest.json", dist);
type Chunk = { file: string; imports?: string[]; isEntry?: boolean; isDynamicEntry?: boolean };
const built = existsSync(manifestFile);
if (!built) console.warn("bundle.dist.test.ts: run npm run build to verify production bundle boundaries");

describe.skipIf(!built)("production bundle boundaries", () => {
  function manifest(): Record<string, Chunk> { return JSON.parse(readFileSync(manifestFile, "utf8")); }
  function staticImports(chunks: Record<string, Chunk>, entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    for (const dep of chunks[entry]?.imports ?? []) staticImports(chunks, dep, seen);
    return seen;
  }
  it("keeps landing, workspace, editor, and diagram off the startup path", () => {
    const chunks = manifest();
    const entry = Object.keys(chunks).find((key) => chunks[key]!.isEntry)!;
    const initial = staticImports(chunks, entry);
    for (const key of ["src/App.tsx", "src/landing/Landing.tsx", "src/components/Editor.tsx", "src/components/SchemaDiagram.tsx"]) {
      expect(chunks[key]?.isDynamicEntry).toBe(true);
      expect(initial.has(key)).toBe(false);
    }
    const initialBytes = [...initial].reduce((sum, key) => sum + statSync(fileURLToPath(new URL(chunks[key]!.file, dist))).size, 0);
    expect(initialBytes).toBeLessThan(250_000);
    const workspace = staticImports(chunks, "src/App.tsx");
    expect(workspace.has("src/components/Editor.tsx")).toBe(false);
    expect(workspace.has("src/components/SchemaDiagram.tsx")).toBe(false);
    // The landing page and the workspace are loaded independently.
    expect(staticImports(chunks, "src/landing/Landing.tsx").has("src/App.tsx")).toBe(false);
    expect(workspace.has("src/landing/Landing.tsx")).toBe(false);
  });
  it("keeps every JavaScript chunk below the existing 500 kB warning threshold", () => {
    for (const chunk of Object.values(manifest())) {
      if (chunk.file.endsWith(".js")) expect(statSync(new URL(chunk.file, dist)).size, chunk.file).toBeLessThan(500_000);
    }
  });
});
