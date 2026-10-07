import { QuotaError } from "@mockdata/accounts";
import { assertRowBudget } from "@mockdata/cli";
import { llmColumns, type DataSchemaT, type LlmConfig } from "@mockdata/core";
import { HttpError, type Ctx } from "../http.js";

/** What one schema may ask of a shared server (the row count has its own, configurable limit). */
export const MAX_TABLES = 50;
export const MAX_COLUMNS_PER_TABLE = 100;
/** A column's instruction is re-sent with every batch, so its length multiplies spend. */
export const MAX_LLM_PROMPT = 500;
/** Table and column names are re-sent with every row of every model batch, so their length multiplies spend. */
export const MAX_NAME_LENGTH = 64;
/** Batches smaller than this, and retries beyond this, multiply the number of model requests. */
const MIN_BATCH = 10;
const MAX_RETRIES = 2;
const MAX_CONTEXT_DEPTH = 1;

/**
 * In accounts mode the operator chooses the provider, model, address and key. A schema may still tune batching,
 * retries and context, but can never name a model, an endpoint or a key variable, and what it tunes is clamped to
 * what the operator can afford.
 */
export function lockedLlmConfig(cfg: LlmConfig | undefined): LlmConfig | undefined {
  if (!cfg) return undefined;
  const { batchSize, maxRetries, contextDepth } = cfg;
  return {
    ...(batchSize !== undefined && { batchSize: Math.max(MIN_BATCH, batchSize) }),
    ...(maxRetries !== undefined && { maxRetries: Math.min(MAX_RETRIES, maxRetries) }),
    ...(contextDepth !== undefined && { contextDepth: Math.min(MAX_CONTEXT_DEPTH, contextDepth) }),
  };
}

/** LLM-written cells a schema would request. */
export function llmCellCount(schema: DataSchemaT): number {
  return llmColumns(schema).reduce((n, c) => n + (schema.tables[table(c)]?.rows ?? 0), 0);
}
const table = (c: { table: string }): string => c.table;

/**
 * Accounts mode: refuse schemas that are cheap to send but expensive to build (too many tables or columns, too many
 * cells, a huge model instruction). A no-op outside accounts mode.
 */
export function assertSchemaShape(ctx: Ctx, schema: DataSchemaT): void {
  if (!ctx.accounts) return;
  const tables = Object.values(schema.tables);
  if (tables.length > MAX_TABLES) throw new HttpError(400, `Schemas are limited to ${MAX_TABLES} tables`);
  let cells = 0;
  for (const [tableName, t] of Object.entries(schema.tables)) {
    if (tableName.length > MAX_NAME_LENGTH) throw new HttpError(400, `Table and column names are limited to ${MAX_NAME_LENGTH} characters`);
    for (const columnName of Object.keys(t.columns)) {
      if (columnName.length > MAX_NAME_LENGTH) throw new HttpError(400, `Table and column names are limited to ${MAX_NAME_LENGTH} characters`);
    }
  }
  for (const t of tables) {
    const columns = Object.values(t.columns);
    if (columns.length > MAX_COLUMNS_PER_TABLE) throw new HttpError(400, `Tables are limited to ${MAX_COLUMNS_PER_TABLE} columns`);
    cells += t.rows * columns.length;
    for (const c of columns) {
      const prompt = typeof c.llm === "object" ? c.llm.prompt : undefined;
      if (prompt && prompt.length > MAX_LLM_PROMPT) throw new HttpError(400, `The instruction for a model-written column is limited to ${MAX_LLM_PROMPT} characters`);
    }
  }
  if (cells > ctx.accounts.limits.maxCells) {
    throw new HttpError(400, `This schema would build ${cells} cells (rows x columns); the limit is ${ctx.accounts.limits.maxCells}`);
  }
}

/**
 * Generation runs on the one event loop (about a second for 500,000 cells), so a signed-in user may not repeat it
 * without limit. Counted per user, for every expensive route. A no-op outside accounts mode.
 */
export async function throttleRun(ctx: Ctx): Promise<void> {
  if (!ctx.accounts || !ctx.user) return;
  const key = String(ctx.user.id);
  if (!(await ctx.accounts.limiters.runUser.hit(key))) throw new QuotaError(`You are sending runs too quickly: wait ${(await ctx.accounts.limiters.runUser.retryAfterSeconds(key))} seconds`);
}

/** Checking a schema is cheap but parses up to 2 MB each time, so it has its own, higher, per-user limit. */
export async function throttleValidate(ctx: Ctx): Promise<void> {
  if (!ctx.accounts || !ctx.user) return;
  const key = String(ctx.user.id);
  if (!(await ctx.accounts.limiters.validateUser.hit(key))) throw new QuotaError(`You are checking schemas too quickly: wait ${(await ctx.accounts.limiters.validateUser.retryAfterSeconds(key))} seconds`);
}

export interface Run {
  /** The schema to generate from (locked to the operator's model settings in accounts mode). */
  schema: DataSchemaT;
  /** Free the user's run slot. Safe to call more than once. */
  done(): void;
}

/**
 * Before a generation: the schema size caps, the row cap, the per-user and server-wide daily LLM budgets and the run
 * slot. A no-op outside accounts mode. Usage is charged up front, so cancelling and retrying cannot be used to dodge
 * the budget.
 */
export async function beginRun(ctx: Ctx, schema: DataSchemaT): Promise<Run> {
  const accounts = ctx.accounts;
  const user = ctx.user;
  if (!accounts || !user) return { schema, done: () => undefined };
  await throttleRun(ctx);
  assertSchemaShape(ctx, schema);
  assertRowBudget(schema, accounts.limits.maxRows);
  const release = await accounts.runs.tryStart(user.id);
  if (!release) throw new QuotaError("A generation is already running for you, or the server is busy: try again in a moment");
  try {
    const cells = llmCellCount(schema);
    if (cells > 0) {
      const taken = await accounts.usage.reserveLlmRows(user.id, cells, accounts.limits.llmDailyRows, accounts.limits.llmGlobalDailyRows);
      if (!taken.ok && taken.reason === "user") {
        throw new QuotaError(`Daily LLM limit: this run needs ${cells} model-written rows and you have ${taken.left} left today (limit ${accounts.limits.llmDailyRows}, resets at midnight UTC)`);
      }
      if (!taken.ok) throw new QuotaError("The server's model budget for today is used up: try again after midnight UTC");
    }
  } catch (e) {
    release();
    throw e;
  }
  const locked = lockedLlmConfig(schema.llm);
  return { schema: { ...schema, llm: { maxRetries: MAX_RETRIES, ...locked } }, done: release };
}
