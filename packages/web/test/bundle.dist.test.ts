import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    for (const key of ["src/App.tsx", "src/landing/Landing.tsx", "src/docs/Docs.tsx", "src/components/Editor.tsx", "src/components/SchemaDiagram.tsx"]) {
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
    expect(workspace.has("src/docs/Docs.tsx")).toBe(false);
    // Each docs translation is its own chunk, fetched only when that language is chosen.
    const docs = staticImports(chunks, "src/docs/Docs.tsx");
    for (const key of ["src/docs/i18n/es.ts", "src/docs/i18n/zh.ts"]) {
      expect(chunks[key]?.isDynamicEntry, key).toBe(true);
      expect(docs.has(key), key).toBe(false);
    }
  });
  it("serves fonts as files, since the CSP blocks data: fonts", () => {
    const css = readdirSync(new URL("assets/", dist)).filter((f) => f.endsWith(".css"));
    expect(css.length).toBeGreaterThan(0);
    for (const file of css) expect(readFileSync(new URL(`assets/${file}`, dist), "utf8"), file).not.toMatch(/data:font\//);
  });
  // The ELK layout engine is a prebuilt worker script (about 1.6 MB), fetched only when a diagram creates its Worker.
  const isElkWorker = (key: string) => key.endsWith("elkjs/lib/elk-worker.min.js");
  it("keeps every JavaScript chunk below the existing 500 kB warning threshold", () => {
    for (const [key, chunk] of Object.entries(manifest())) {
      if (chunk.file.endsWith(".js") && !isElkWorker(key)) expect(statSync(new URL(chunk.file, dist)).size, chunk.file).toBeLessThan(500_000);
    }
  });
  it("ships the ELK worker as a separate asset that no chunk imports", () => {
    const chunks = manifest();
    const worker = Object.keys(chunks).find(isElkWorker);
    expect(worker).toBeDefined();
    for (const chunk of Object.values(chunks)) expect(chunk.imports ?? []).not.toContain(worker);
    expect(statSync(new URL(chunks[worker!]!.file, dist)).size).toBeLessThan(2_500_000);
  });
});
