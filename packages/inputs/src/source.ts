import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { InferError, type InferOptions, type InferResult } from "./common.js";
import { detectDatabase, inferFromDatabase, type DatabaseOptions } from "./db/index.js";
import { fromJsonSchema } from "./jsonschema.js";
import { guessSampleFormat, inferFromSamples, parseSample, type SampleOptions, type SampleRow } from "./sample.js";

export type SourceKind = "json-schema" | "sample" | "database";

export interface SourceOptions extends SampleOptions, DatabaseOptions {
  /** Force the interpretation instead of detecting it. */
  kind?: SourceKind;
}

const SAMPLE_EXT = /\.(csv|json|ndjson|jsonl)$/i;

/** Sample files are read fully into memory; refuse absurd sizes instead of exhausting it. */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

function readCapped(file: string): string {
  const size = statSync(file).size;
  if (size > MAX_SOURCE_BYTES) throw new InferError(`${path.basename(file)} is ${Math.round(size / 1e6)} MB; the limit is ${MAX_SOURCE_BYTES / 1024 / 1024} MB (use a smaller sample)`);
  return readFileSync(file, "utf8");
}

/** A document that describes structure (vs. an array/object of example rows). */
export function looksLikeJsonSchema(doc: unknown): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  const d = doc as Record<string, unknown>;
  return (
    "openapi" in d || "swagger" in d || "$schema" in d || "$defs" in d || "definitions" in d ||
    "components" in d || ("properties" in d && (d.type === "object" || d.type === undefined))
  );
}

/** Infer from sample files; several files become several tables (foreign keys are found across them). */
export function inferFromSampleFiles(files: { name: string; text: string }[], opts: SampleOptions = {}): InferResult {
  const tables: Record<string, SampleRow[]> = {};
  const textual: Record<string, boolean> = {};
  for (const f of files) {
    const format = guessSampleFormat(f.name, f.text);
    for (const [name, rows] of Object.entries(parseSample(f.text, f.name, format))) {
      if (tables[name]) throw new InferError(`Two sample files produce a table named "${name}"`);
      tables[name] = rows;
      textual[name] = format === "csv";
    }
  }
  return inferFromSamples(tables, { ...opts, textual });
}

/**
 * Infer a schema from a database URL, a SQLite file, a JSON Schema / OpenAPI
 * file, a sample file (.csv, .json, .ndjson), or a directory of sample files.
 */
export async function inferFromSource(source: string, opts: SourceOptions = {}): Promise<InferResult> {
  const kind = opts.kind ?? (detectDatabase(source) ? "database" : undefined);
  if (kind === "database") return inferFromDatabase(source, opts);

  let stat;
  try {
    stat = statSync(source);
  } catch {
    throw new InferError(`No such file or directory: ${source}`);
  }

  if (stat.isDirectory()) {
    // Links are never followed: one could point at .env or a file outside the folder the caller was allowed to name.
    const skipped: string[] = [];
    const names = readdirSync(source)
      .filter((f) => SAMPLE_EXT.test(f))
      .sort()
      .filter((f) => {
        const isLink = lstatSync(path.join(source, f)).isSymbolicLink();
        if (isLink) skipped.push(f);
        return !isLink;
      });
    const files = names.map((f) => ({ name: f, text: readCapped(path.join(source, f)) }));
    if (files.length === 0) throw new InferError(`No .csv, .json or .ndjson files in ${source}`);
    const result = inferFromSampleFiles(files, opts);
    for (const f of skipped) result.warnings.push(`Skipped ${f}: symlinks in a sample folder are not followed`);
    return result;
  }

  const text = readCapped(source);
  const ext = path.extname(source).toLowerCase();
  if (kind === "json-schema" || (!kind && (ext === ".yaml" || ext === ".yml"))) return fromJsonSchema(parseYaml(text), opts);
  if (!kind && ext === ".json") {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new InferError(`${source}: invalid JSON (${(e as Error).message})`);
    }
    if (looksLikeJsonSchema(doc)) return fromJsonSchema(doc as Record<string, unknown>, opts);
  }
  return inferFromSampleFiles([{ name: path.basename(source), text }], opts);
}

export type { InferOptions };
