import { serialize } from "@mockdata/cli";
import { generate, planGeneration, type DataSchemaT, type Dataset } from "@mockdata/core";
import { generateWithLlm, type GenerateWithLlmOptions, type LlmProgress, type LlmReport } from "@mockdata/llm";
import { buildPreview, capRowsForPreview, type Preview } from "../preview.js";
import { zip } from "../zip.js";

/** The row counts the schema asks for, before any preview subsetting. */
function fullCounts(schema: DataSchemaT): Record<string, number> {
  return Object.fromEntries(Object.entries(schema.tables).map(([t, table]) => [t, table.rows]));
}

/**
 * The heavy work behind the preview, run and export routes, described as plain data so it can cross a thread
 * boundary. Everything in a job and in its result survives structured clone (no functions, classes or Maps).
 */
export interface PreviewJob {
  kind: "preview";
  schema: DataSchemaT;
  seed?: number;
  previewRows: number;
  tables?: string[];
}
export interface RunJob {
  kind: "run";
  schema: DataSchemaT;
  seed?: number;
  previewRows: number;
  tables?: string[];
  /** Environment for the model provider (keys, model, address). */
  env: Record<string, string | undefined>;
}
export interface ExportJob {
  kind: "export";
  schema: DataSchemaT;
  seed?: number;
  format: "json" | "ndjson" | "csv";
  /** Return one zip archive instead of one text per table. */
  zip: boolean;
  env: Record<string, string | undefined>;
}
/** The MCP generate_data tool: every row is generated, but only counts, the first rows and (optionally) the files come back. */
export interface SampleJob {
  kind: "sample";
  schema: DataSchemaT;
  seed?: number;
  /** Rows per table to return as they are. */
  sampleRows: number;
  /** Also serialize every table in this format. */
  format?: "json" | "ndjson" | "csv";
  env: Record<string, string | undefined>;
}
export type Job = PreviewJob | RunJob | ExportJob | SampleJob;

export interface JobResults {
  preview: { preview: Preview };
  run: { preview: Preview; report: LlmReport };
  export: { counts: Record<string, number>; report: LlmReport; texts?: Record<string, string>; archive?: Uint8Array };
  sample: { counts: Record<string, number>; report: LlmReport; sample: Dataset; texts?: Record<string, string> };
}
export type ResultOf<J extends Job> = JobResults[J["kind"]];

export interface JobHooks {
  signal?: AbortSignal;
  onProgress?: (p: LlmProgress) => void;
  /** Test hooks (a fake provider or fetch): functions, so only the in-process runner can use them. */
  llm?: Pick<GenerateWithLlmOptions, "provider" | "fetch" | "sleep">;
}

/**
 * The single implementation of the pipeline: generate, fill model-written columns, validate, then build the preview
 * or serialize (and zip). The worker thread and the in-process runner both call this, so they cannot drift apart.
 * Only a small result leaves: the dataset itself never does.
 */
export async function runJob<J extends Job>(job: J, hooks: JobHooks = {}): Promise<ResultOf<J>> {
  const j = job as Job;
  if (j.kind === "preview") {
    // Model-written columns stay pending here; the run route fills them.
    // Only the rows the preview shows are generated (parents first, same seed, so foreign keys resolve inside the
    // subset); `counts` still reports the full schema row counts, as before. The subset's rows are not the first
    // rows of a full generation — a smaller parent pool changes the foreign-key picks — but they are deterministic
    // for a given seed/schema/previewRows.
    const subset = capRowsForPreview(j.schema, j.previewRows);
    const data = generate(subset, { seed: j.seed, deferLlm: true, parsed: subset, plan: planGeneration(subset) });
    return { preview: buildPreview(j.schema, data, { seed: j.seed, rows: j.previewRows, tables: j.tables, counts: fullCounts(j.schema) }) } as ResultOf<J>;
  }
  // The schema arrives here already parsed (the route ran parseSchemaBody), so it is passed through as `parsed`
  // with one precomputed `plan` instead of being re-parsed (Zod) and re-planned by generateWithLlm, generate and
  // fillLlmColumns — one parse per run, at the entry point. The plan is computed for the effective (subset) schema.
  // Preview and run jobs only need the rows the preview shows (see the preview branch above). A sample job
  // without a format only returns sampleRows rows per table, so it gets the same treatment; with a format the
  // serialised texts need every row, so it still generates the full dataset.
  const subset =
    j.kind === "run"
      ? capRowsForPreview(j.schema, j.previewRows)
      : j.kind === "sample" && !j.format
        ? capRowsForPreview(j.schema, j.sampleRows)
        : j.schema;
  const { data, report } = await generateWithLlm(subset, { seed: j.seed, ...hooks.llm, env: j.env, signal: hooks.signal, onProgress: hooks.onProgress, parsed: subset, plan: planGeneration(subset) });
  if (j.kind === "sample") {
    const counts = fullCounts(j.schema);
    const sample = Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.slice(0, j.sampleRows)]));
    const format = j.format;
    const texts = format && Object.fromEntries(Object.keys(j.schema.tables).map((table) => [table, serialize(data[table]!, Object.keys(j.schema.tables[table]!.columns), format)]));
    return { counts, report, sample, ...(texts ? { texts } : {}) } as ResultOf<J>;
  }
  if (j.kind === "run") {
    return { preview: buildPreview(j.schema, data, { seed: j.seed, rows: j.previewRows, tables: j.tables, counts: fullCounts(j.schema) }), report } as ResultOf<J>;
  }
  const counts = Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.length]));
  const text = (table: string) => serialize(data[table]!, Object.keys(j.schema.tables[table]!.columns), j.format);
  if (j.zip) {
    // The export still generates every row; the saving is in the archive (deflate, strings passed straight in).
    const archive = zip(Object.keys(j.schema.tables).map((table) => ({ name: `${table}.${j.format}`, data: text(table) })));
    return { counts, report, archive: new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength) } as ResultOf<J>;
  }
  return { counts, report, texts: Object.fromEntries(Object.keys(j.schema.tables).map((table) => [table, text(table)])) } as ResultOf<J>;
}
