import {
  generate,
  llmColumns,
  planGeneration,
  parseSchema,
  validate,
  type Dataset,
  type GenerateOptions,
  type Row,
} from "@mockdata/core";
import { resolveLlmConfig } from "./config.js";
import { createContextBuilder } from "./context.js";
import { createProvider, LlmHttpError, type LlmProvider, type ProviderDeps } from "./provider.js";

export class LlmFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmFillError";
  }
}

export class LlmCancelledError extends Error {
  constructor() {
    super("LLM generation was cancelled");
    this.name = "LlmCancelledError";
  }
}

export interface LlmProgress {
  /** "table.column" */
  column: string;
  /** Rows of that column filled so far, and how many it needs. */
  done: number;
  total: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface FillOptions {
  provider: LlmProvider;
  batchSize?: number;
  maxRetries?: number;
  /** Foreign-key hops of parent context per row (default: schema llm.contextDepth, else 1). */
  contextDepth?: number;
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each batch is stored. */
  onProgress?: (e: LlmProgress) => void;
  /** Checked before each request; once aborted the run stops with LlmCancelledError (a request already in flight finishes). */
  signal?: AbortSignal;
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
/** Output tokens budgeted per requested value: generous, because descriptive text runs 100+ tokens. */
const TOKENS_PER_VALUE = 150;
const MAX_OUTPUT_TOKENS = 8192;
const AVOID_LIST_SIZE = 40;

/** A reply that starts a JSON array but never closes it was cut off, even if the provider did not say so. */
function looksTruncated(text: string): boolean {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return t.startsWith("[") && !t.endsWith("]");
}

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

const SYSTEM =
  "You write realistic synthetic data values for a test database. " +
  "Reply with ONLY a JSON array of strings, one per requested row, in order. No commentary, no code fences.";

interface PromptInput {
  table: string;
  column: string;
  instruction?: string;
  rows: Row[];
  unique: boolean;
  avoid: string[];
  describe: (row: Row) => string;
  /** Rows carry nested parent context (foreign keys expanded into the parent's values). */
  hasRelated: boolean;
}

function buildPrompt({ table, column, instruction, rows, unique, avoid, describe, hasRelated }: PromptInput): string {
  const lines = [
    `Table: ${table}`,
    `Column to write: ${column}`,
    ...(instruction ? [`Instruction: ${instruction}`] : []),
    `Write one realistic, varied value for this column for each of the ${rows.length} rows below, consistent with each row's other values.`,
    ...(hasRelated
      ? [
          'A value nested under another name, such as "product": {...}, describes the related row this row belongs to. ' +
            "Use those details where they fit naturally, and keep values varied even when several rows share the same related row.",
        ]
      : []),
    ...(unique ? ["All values must be distinct from each other."] : []),
    ...(avoid.length ? [`Do not reuse any of these: ${JSON.stringify(avoid)}`] : []),
    "Rows:",
    ...rows.map((r, i) => `${i}: ${describe(r)}`),
    `Reply with only a JSON array of exactly ${rows.length} strings, in row order.`,
  ];
  return lines.join("\n");
}

/**
 * Fill every `llm` cell still pending (undefined) in `data`, in place.
 * Columns are filled one at a time, parent tables before child tables (then
 * schema order), so a row's prompt can include parent values that were
 * themselves written by the model, and later columns see earlier ones.
 */
export async function fillLlmColumns(input: unknown, data: Dataset, opts: FillOptions): Promise<LlmReport> {
  const schema = parseSchema(input);
  const sleep = opts.sleep ?? defaultSleep;
  const batchSize = opts.batchSize ?? schema.llm?.batchSize ?? 20;
  const maxRetries = opts.maxRetries ?? schema.llm?.maxRetries ?? 3;
  const contextDepth = opts.contextDepth ?? schema.llm?.contextDepth ?? 1;
  const context = createContextBuilder(schema, data, contextDepth);
  const report: LlmReport = { calls: 0, inputTokens: 0, outputTokens: 0, columns: {} };

  // Parent tables first, so children can see what the model wrote for their parents.
  const level = new Map<string, number>();
  planGeneration(schema).levels.forEach((names, i) => names.forEach((n) => level.set(n, i)));
  const ordered = llmColumns(schema)
    .map((c, i) => ({ ...c, order: i }))
    .sort((a, b) => level.get(a.table)! - level.get(b.table)! || a.order - b.order);

  /** One request with retries; returns exactly `expected` strings or throws. */
  async function ask(where: string, prompt: string, expected: number): Promise<string[]> {
    let lastError = "no attempts made";
    let maxTokens = Math.min(MAX_OUTPUT_TOKENS, 256 + expected * TOKENS_PER_VALUE);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      try {
        report.calls++;
        const res = await opts.provider.complete({ system: SYSTEM, user: prompt, maxTokens });
        report.inputTokens += res.usage.inputTokens;
        report.outputTokens += res.usage.outputTokens;
        const values = parseStringArray(res.text);
        if (!values) {
          if (res.truncated || looksTruncated(res.text)) {
            // Repeating the same request would be cut off at the same place: give it more room.
            if (maxTokens >= MAX_OUTPUT_TOKENS) {
              throw new LlmFillError(`${where}: replies are cut off even at ${MAX_OUTPUT_TOKENS} tokens; lower "llm.batchSize" so each request asks for fewer rows`);
            }
            lastError = `reply was cut off at ${maxTokens} tokens`;
            maxTokens = Math.min(MAX_OUTPUT_TOKENS, maxTokens * 2);
            continue;
          }
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

  for (const { table, column, prompt } of ordered) {
    const where = `${table}.${column}`;
    const col = schema.tables[table]!.columns[column]!;
    const rows = data[table] ?? [];
    const unique = !!col.unique;
    const taken = new Set<string>();
    let pending = rows.map((_, i) => i).filter((i) => rows[i]![column] === undefined);
    report.columns[where] = pending.length;
    const total = pending.length;
    let filled = 0;

    for (let round = 0; pending.length > 0; round++) {
      if (round >= MAX_UNIQUE_ROUNDS) {
        throw new LlmFillError(`${where}: ${pending.length} value(s) still duplicated after ${MAX_UNIQUE_ROUNDS} rounds`);
      }
      const rejected: number[] = [];
      for (let i = 0; i < pending.length; i += batchSize) {
        if (opts.signal?.aborted) throw new LlmCancelledError();
        const idxs = pending.slice(i, i + batchSize);
        const avoid = unique ? [...taken].slice(-AVOID_LIST_SIZE) : [];
        const values = await ask(
          where,
          buildPrompt({
            table,
            column,
            instruction: prompt,
            rows: idxs.map((n) => rows[n]!),
            unique,
            avoid,
            describe: (row) => context.describe(table, row, column),
            hasRelated: context.hasRelated(table),
          }),
          idxs.length,
        );
        idxs.forEach((n, k) => {
          const v = values[k]!.trim();
          if (v === "" || (unique && taken.has(v))) {
            rejected.push(n);
            return;
          }
          taken.add(v);
          rows[n]![column] = v;
          filled++;
        });
        opts.onProgress?.({
          column: where,
          done: filled,
          total,
          calls: report.calls,
          inputTokens: report.inputTokens,
          outputTokens: report.outputTokens,
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
  onProgress?: FillOptions["onProgress"];
  signal?: AbortSignal;
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
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? createProvider(resolveLlmConfig(schema.llm, env), { fetch: opts.fetch, env });
  const report = await fillLlmColumns(schema, data, { provider, sleep: opts.sleep, onProgress: opts.onProgress, signal: opts.signal });
  validate(schema, data);
  return { data, report };
}
