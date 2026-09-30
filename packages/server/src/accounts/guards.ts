import { assertRowBudget } from "@mockdata/cli";
import { llmColumns, type DataSchemaT, type LlmConfig } from "@mockdata/core";
import { QuotaError } from "@mockdata/accounts";
import type { Ctx } from "../http.js";

/**
 * In accounts mode the operator chooses the provider, model, address and key. A schema may still tune
 * batching, retries and context, but can never name a model, an endpoint or a key variable.
 */
export function lockedLlmConfig(cfg: LlmConfig | undefined): LlmConfig | undefined {
  if (!cfg) return undefined;
  const { batchSize, maxRetries, contextDepth } = cfg;
  return { ...(batchSize !== undefined && { batchSize }), ...(maxRetries !== undefined && { maxRetries }), ...(contextDepth !== undefined && { contextDepth }) };
}

/** LLM-written cells a schema would request. */
export function llmCellCount(schema: DataSchemaT): number {
  return llmColumns(schema).reduce((n, c) => n + (schema.tables[c.table]?.rows ?? 0), 0);
}

export interface Run {
  /** The schema to generate from (locked to the operator's model settings in accounts mode). */
  schema: DataSchemaT;
  /** Free the user's run slot. Safe to call more than once. */
  done(): void;
}

/**
 * Before a generation: the row cap, the daily LLM budget and the run slots. A no-op outside accounts mode.
 * Usage is charged up front, so cancelling and retrying cannot be used to dodge the budget.
 */
export async function beginRun(ctx: Ctx, schema: DataSchemaT): Promise<Run> {
  const accounts = ctx.accounts;
  const user = ctx.user;
  if (!accounts || !user) return { schema, done: () => undefined };
  assertRowBudget(schema, accounts.limits.maxRows);
  const release = accounts.runs.tryStart(user.id);
  if (!release) throw new QuotaError("A generation is already running for you, or the server is busy: try again in a moment");
  try {
    const cells = llmCellCount(schema);
    if (cells > 0) {
      const left = accounts.limits.llmDailyRows - (await accounts.usage.llmRowsToday(user.id));
      if (cells > left) {
        throw new QuotaError(`Daily LLM limit: this run needs ${cells} model-written rows and you have ${Math.max(0, left)} left today (limit ${accounts.limits.llmDailyRows}, resets at midnight UTC)`);
      }
      await accounts.usage.addLlmRows(user.id, cells);
    }
  } catch (e) {
    release();
    throw e;
  }
  return { schema: { ...schema, llm: lockedLlmConfig(schema.llm) }, done: release };
}
