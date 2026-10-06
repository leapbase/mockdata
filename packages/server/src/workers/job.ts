import { serialize } from "@mockdata/cli";
import { generate, type DataSchemaT, type Dataset } from "@mockdata/core";
import { generateWithLlm, type GenerateWithLlmOptions, type LlmProgress, type LlmReport } from "@mockdata/llm";
import { buildPreview, type Preview } from "../preview.js";
import { zip } from "../zip.js";

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
    const data = generate(j.schema, { seed: j.seed, deferLlm: true });
    return { preview: buildPreview(j.schema, data, { seed: j.seed, rows: j.previewRows, tables: j.tables }) } as ResultOf<J>;
  }
  const { data, report } = await generateWithLlm(j.schema, { seed: j.seed, ...hooks.llm, env: j.env, signal: hooks.signal, onProgress: hooks.onProgress });
  if (j.kind === "sample") {
    const counts = Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.length]));
    const sample = Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.slice(0, j.sampleRows)]));
    const format = j.format;
    const texts = format && Object.fromEntries(Object.keys(j.schema.tables).map((table) => [table, serialize(data[table]!, Object.keys(j.schema.tables[table]!.columns), format)]));
    return { counts, report, sample, ...(texts ? { texts } : {}) } as ResultOf<J>;
  }
  if (j.kind === "run") {
    return { preview: buildPreview(j.schema, data, { seed: j.seed, rows: j.previewRows, tables: j.tables }), report } as ResultOf<J>;
  }
  const counts = Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.length]));
  const text = (table: string) => serialize(data[table]!, Object.keys(j.schema.tables[table]!.columns), j.format);
  if (j.zip) {
    const archive = zip(Object.keys(j.schema.tables).map((table) => ({ name: `${table}.${j.format}`, data: Buffer.from(text(table)) })));
    return { counts, report, archive: new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength) } as ResultOf<J>;
  }
  return { counts, report, texts: Object.fromEntries(Object.keys(j.schema.tables).map((table) => [table, text(table)])) } as ResultOf<J>;
}
