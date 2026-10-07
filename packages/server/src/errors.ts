import { UserError } from "@mockdata/cli";
import { BusyError, CycleError, GenerationError, SchemaError, QuotaError, ValidationError } from "@mockdata/core";
import { LlmConfigError, LlmFillError, LlmHttpError } from "@mockdata/llm";
import { HttpError } from "./http.js";
import { JobTimeoutError } from "./workers/errors.js";

/** Errors caused by the caller's schema or input are 400; failures talking to a model are 502. */
export function statusFor(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof QuotaError) return 429;
  if (e instanceof BusyError) return 503; // too much queued work
  if (e instanceof JobTimeoutError) return 504; // a job ran too long and was stopped
  if (e instanceof LlmFillError || e instanceof LlmHttpError) return 502;
  if (
    e instanceof UserError ||
    e instanceof SchemaError ||
    e instanceof CycleError ||
    e instanceof GenerationError ||
    e instanceof ValidationError ||
    e instanceof LlmConfigError
  ) {
    return 400;
  }
  return 500;
}

const GENERIC = "Something went wrong. Try again, and tell the operator if it keeps happening.";
const MODEL_DOWN = "The model service could not complete the request. Try again later.";
const BUSY = "The server is busy: try again in a moment.";
const TOO_LONG = "That took too long and was stopped. Try a smaller schema.";
export const MODELS_OFF = "Model-written columns are not available on this server";

/**
 * What a caller is told about a failure. Messages from the errors above name variables, never values, so they are
 * shown as they are. Anything else (a file system error, a bug) can carry server paths, so on a public server it is
 * replaced by a generic line and the detail goes to the operator's log only.
 */
export function publicMessage(e: unknown, hideInternals: boolean): string {
  const err = e as Error;
  if (!hideInternals) return err.message;
  const status = statusFor(e);
  if (status === 503) return BUSY;
  if (status === 504) return TOO_LONG;
  if (status === 502) {
    // The text carries the operator's model address and whatever the provider said (balances, account names).
    process.stderr.write(`model error: ${err.message}\n`);
    return MODEL_DOWN;
  }
  if (e instanceof LlmConfigError) {
    process.stderr.write(`model configuration: ${err.message}\n`);
    return MODELS_OFF;
  }
  if (status !== 500) return err.message;
  process.stderr.write(`internal error: ${err.stack ?? err.message}\n`);
  return GENERIC;
}
