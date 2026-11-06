import {
  generate,
  llmColumns,
  planGeneration,
  parseSchema,
  validate,
  type DataSchemaT,
  type Dataset,
  type GenerateOptions,
  type GenerationPlan,
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
  /**
   * Max LLM batches in flight within one round of one column (default 4).
   * 2,000 rows at batch 20 is 100 calls; sequential at ~1.5 s/call that is
   * ~150 s, past the 120 s job timeout, while 4 in flight is ~38 s. Kept
   * small on purpose: providers rate-limit (429s are retried, but a retry
   * storm helps nobody) and every in-flight request is paid for even if
   * the run is cancelled mid-round.
   */
  concurrency?: number;
  /**
   * Already-parsed schema: skips parseSchema(input). When absent the raw
   * input is parsed as today, so existing callers are unaffected.
   */
  parsed?: DataSchemaT;
  /** Precomputed generation plan: skips planGeneration(schema). */
  plan?: GenerationPlan;
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
  const schema = opts.parsed ?? parseSchema(input);
  const sleep = opts.sleep ?? defaultSleep;
  const batchSize = opts.batchSize ?? schema.llm?.batchSize ?? 20;
  const maxRetries = opts.maxRetries ?? schema.llm?.maxRetries ?? 3;
  const contextDepth = opts.contextDepth ?? schema.llm?.contextDepth ?? 1;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const context = createContextBuilder(schema, data, contextDepth);
  const report: LlmReport = { calls: 0, inputTokens: 0, outputTokens: 0, columns: {} };

  // Parent tables first, so children can see what the model wrote for their parents.
  const plan = opts.plan ?? planGeneration(schema);
  const level = new Map<string, number>();
  plan.levels.forEach((names, i) => names.forEach((n) => level.set(n, i)));
  const ordered = llmColumns(schema)
    .map((c, i) => ({ ...c, order: i }))
    .sort((a, b) => level.get(a.table)! - level.get(b.table)! || a.order - b.order);

  /** Backoff that wakes as soon as the run is cancelled. */
  async function sleepUnlessAborted(ms: number): Promise<void> {
    const signal = opts.signal;
    if (!signal) return sleep(ms);
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([sleep(ms), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** One request with retries; returns exactly `expected` strings or throws. */
  async function ask(where: string, prompt: string, expected: number): Promise<string[]> {
    let lastError = "no attempts made";
    let maxTokens = Math.min(MAX_OUTPUT_TOKENS, 256 + expected * TOKENS_PER_VALUE);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleepUnlessAborted(Math.min(500 * 2 ** (attempt - 1), 8000));
      // Retries are model requests too: a cancelled run must not make (or pay for) another one.
      if (opts.signal?.aborted) throw new LlmCancelledError();
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
    // The parent-context cache lives for this column only: parent values
    // are stable while it fills, but an earlier column's model-written
    // text must be visible to later columns (see context.ts).
    context.beginColumn();

    for (let round = 0; pending.length > 0; round++) {
      if (round >= MAX_UNIQUE_ROUNDS) {
        throw new LlmFillError(`${where}: ${pending.length} value(s) still duplicated after ${MAX_UNIQUE_ROUNDS} rounds`);
      }
      // Batches within one round run concurrently (up to `concurrency` in
      // flight); rounds stay sequential so the `unique` re-ask state is
      // exact. Each batch writes only its own rows, and the write-back
      // below runs synchronously, so the duplicate check-then-add on
      // `taken` cannot interleave between batches. A batch's `avoid` list
      // is a snapshot of `taken` when that batch starts, so under
      // concurrency a later batch may not avoid an earlier batch's values
      // yet — duplicates are still caught at write-back and re-asked in
      // the next round, which is what the rounds are for.
      const batches: number[][] = [];
      for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
      const rejected: number[] = [];
      let next = 0;
      let stopped = false;
      let firstError: unknown;
      const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () => (async () => {
        for (;;) {
          if (stopped || opts.signal?.aborted) return;
          const idxs = batches[next++];
          if (!idxs) return;
          const avoid = unique ? [...taken].slice(-AVOID_LIST_SIZE) : [];
          let values: string[];
          try {
            values = await ask(
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
          } catch (e) {
            // No new batches start; the ones already in flight finish.
            stopped = true;
            firstError ??= e;
            return;
          }
          // A request already in flight finishes even when the run is
          // cancelled; its values are stored, then the round throws below.
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
          // A row just written can be the parent of a later batch's row
          // (a self-referencing table), so later batches must not reuse
          // the cached parent context built before this write.
          context.invalidate(table);
          opts.onProgress?.({
            column: where,
            done: filled,
            total,
            calls: report.calls,
            inputTokens: report.inputTokens,
            outputTokens: report.outputTokens,
          });
        }
      })());
      await Promise.all(workers);
      if (firstError) throw firstError;
      // Cancelled once the round's batches are done: stop only if there is
      // still work (unstarted batches, or rows to re-ask). If the column
      // is complete, the run returns as it did before — an abort landing
      // after the last batch is not an error.
      if (opts.signal?.aborted && (next < batches.length || rejected.length > 0)) throw new LlmCancelledError();
      // Batches may complete out of order; keep the next round's row order
      // identical to the sequential fill's.
      rejected.sort((a, b) => a - b);
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
  /** Max LLM batches in flight within one round of one column (default 4); forwarded to fillLlmColumns. */
  concurrency?: number;
  /**
   * Already-parsed schema: skips parsing it again here, in fillLlmColumns,
   * and in `generate()` (core accepts a `parsed` option).
   */
  parsed?: DataSchemaT;
  /**
   * Precomputed generation plan: skips planGeneration in fillLlmColumns and
   * in generate() (core accepts a `plan` option).
   */
  plan?: GenerationPlan;
}

/** Deterministic generation, then LLM fill of `llm` columns, then full validation. */
export async function generateWithLlm(
  input: unknown,
  opts: GenerateWithLlmOptions = {},
): Promise<{ data: Dataset; report: LlmReport }> {
  const schema = opts.parsed ?? parseSchema(input);
  const plan = opts.plan ?? planGeneration(schema);
  if (llmColumns(schema).length === 0) {
    const data = generate(schema, { seed: opts.seed, deferLlm: true, parsed: schema, plan });
    return { data, report: { calls: 0, inputTokens: 0, outputTokens: 0, columns: {} } };
  }
  // `parsed` / `plan` are forwarded to generate() (core accepts both, so it skips its own parse and plan).
  const data = generate(schema, { seed: opts.seed, deferLlm: true, parsed: schema, plan });
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? createProvider(resolveLlmConfig(schema.llm, env), { fetch: opts.fetch, env });
  const report = await fillLlmColumns(schema, data, { provider, sleep: opts.sleep, onProgress: opts.onProgress, signal: opts.signal, concurrency: opts.concurrency, parsed: schema, plan });
  validate(schema, data);
  return { data, report };
}
