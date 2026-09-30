import {
  generate,
  llmColumns,
  parseSchema,
  validate,
  type Dataset,
  type GenerateOptions,
  type Row,
} from "@mockdata/core";
import { createProvider, LlmHttpError, type LlmProvider, type ProviderDeps } from "./provider.js";

export class LlmFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmFillError";
  }
}

export interface FillOptions {
  provider: LlmProvider;
  batchSize?: number;
  maxRetries?: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LlmReport {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** "table.column" -> rows filled. */
  columns: Record<string, number>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_UNIQUE_ROUNDS = 3;
const AVOID_LIST_SIZE = 40;

/** Pull a JSON array of strings out of a model reply (tolerates code fences and chatter). */
export function parseStringArray(text: string): string[] | undefined {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [stripped];
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(stripped.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

function rowContext(row: Row, skip: string): string {
  const ctx: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === skip || v === null || v === undefined) continue;
    ctx[k] = typeof v === "string" && v.length > 60 ? v.slice(0, 57) + "..." : v;
    if (Object.keys(ctx).length >= 10) break;
  }
  return JSON.stringify(ctx);
}

const SYSTEM =
  "You write realistic synthetic data values for a test database. " +
  "Reply with ONLY a JSON array of strings, one per requested row, in order. No commentary, no code fences.";

function buildPrompt(table: string, column: string, instruction: string | undefined, rows: Row[], unique: boolean, avoid: string[]): string {
  const lines = [
    `Table: ${table}`,
    `Column to write: ${column}`,
    ...(instruction ? [`Instruction: ${instruction}`] : []),
    `Write one realistic, varied value for this column for each of the ${rows.length} rows below, consistent with each row's other values.`,
    ...(unique ? ["All values must be distinct from each other."] : []),
    ...(avoid.length ? [`Do not reuse any of these: ${JSON.stringify(avoid)}`] : []),
    "Rows:",
    ...rows.map((r, i) => `${i}: ${rowContext(r, column)}`),
    `Reply with only a JSON array of exactly ${rows.length} strings, in row order.`,
  ];
  return lines.join("\n");
}

/**
 * Fill every `llm` cell still pending (undefined) in `data`, in place.
 * Columns are filled one at a time in schema order, so later columns see
 * earlier ones as row context.
 */
export async function fillLlmColumns(input: unknown, data: Dataset, opts: FillOptions): Promise<LlmReport> {
  const schema = parseSchema(input);
  const sleep = opts.sleep ?? defaultSleep;
  const batchSize = opts.batchSize ?? schema.llm?.batchSize ?? 20;
  const maxRetries = opts.maxRetries ?? schema.llm?.maxRetries ?? 3;
  const report: LlmReport = { calls: 0, inputTokens: 0, outputTokens: 0, columns: {} };

  /** One request with retries; returns exactly `expected` strings or throws. */
  async function ask(where: string, prompt: string, expected: number): Promise<string[]> {
    let lastError = "no attempts made";
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      try {
        report.calls++;
        const res = await opts.provider.complete({ system: SYSTEM, user: prompt, maxTokens: Math.min(8192, 256 + expected * 100) });
        report.inputTokens += res.usage.inputTokens;
        report.outputTokens += res.usage.outputTokens;
        const values = parseStringArray(res.text);
        if (!values) {
          lastError = `reply was not a JSON array of strings: ${res.text.slice(0, 120)}`;
          continue;
        }
        if (values.length !== expected) {
          lastError = `expected ${expected} values, got ${values.length}`;
          continue;
        }
        return values;
      } catch (e) {
        if (e instanceof LlmHttpError && e.retryable) {
          lastError = e.message;
          continue;
        }
        throw e;
      }
    }
    throw new LlmFillError(`${where}: gave up after ${maxRetries + 1} attempts (${lastError})`);
  }

  for (const { table, column, prompt } of llmColumns(schema)) {
    const where = `${table}.${column}`;
    const col = schema.tables[table]!.columns[column]!;
    const rows = data[table] ?? [];
    const unique = !!col.unique;
    const taken = new Set<string>();
    let pending = rows.map((_, i) => i).filter((i) => rows[i]![column] === undefined);
    report.columns[where] = pending.length;

    for (let round = 0; pending.length > 0; round++) {
      if (round >= MAX_UNIQUE_ROUNDS) {
        throw new LlmFillError(`${where}: ${pending.length} value(s) still duplicated after ${MAX_UNIQUE_ROUNDS} rounds`);
      }
      const rejected: number[] = [];
      for (let i = 0; i < pending.length; i += batchSize) {
        const idxs = pending.slice(i, i + batchSize);
        const avoid = unique ? [...taken].slice(-AVOID_LIST_SIZE) : [];
        const values = await ask(where, buildPrompt(table, column, prompt, idxs.map((n) => rows[n]!), unique, avoid), idxs.length);
        idxs.forEach((n, k) => {
          const v = values[k]!.trim();
          if (v === "" || (unique && taken.has(v))) {
            rejected.push(n);
            return;
          }
          taken.add(v);
          rows[n]![column] = v;
        });
      }
      pending = rejected;
      if (!unique && pending.length > 0 && round >= 1) {
        // Empty strings keep coming back; a non-unique column has nothing else to retry on.
        throw new LlmFillError(`${where}: model kept returning empty values for ${pending.length} row(s)`);
      }
    }
  }
  return report;
}

export interface GenerateWithLlmOptions extends GenerateOptions, ProviderDeps {
  /** Supply a provider directly (tests, custom backends); otherwise built from schema.llm. */
  provider?: LlmProvider;
  sleep?: (ms: number) => Promise<void>;
}

/** Deterministic generation, then LLM fill of `llm` columns, then full validation. */
export async function generateWithLlm(
  input: unknown,
  opts: GenerateWithLlmOptions = {},
): Promise<{ data: Dataset; report: LlmReport }> {
  const schema = parseSchema(input);
  const data = generate(schema, { seed: opts.seed, deferLlm: true });
  if (llmColumns(schema).length === 0) {
    return { data, report: { calls: 0, inputTokens: 0, outputTokens: 0, columns: {} } };
  }
  const provider = opts.provider ?? createProvider(schema.llm!, { fetch: opts.fetch, env: opts.env });
  const report = await fillLlmColumns(schema, data, { provider, sleep: opts.sleep });
  validate(schema, data);
  return { data, report };
}
