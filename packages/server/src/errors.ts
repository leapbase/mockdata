import { QuotaError } from "@mockdata/accounts";
import { UserError } from "@mockdata/cli";
import { CycleError, GenerationError, SchemaError, ValidationError } from "@mockdata/core";
import { LlmConfigError, LlmFillError, LlmHttpError } from "@mockdata/llm";
import { HttpError } from "./http.js";

/** Errors caused by the caller's schema or input are 400; failures talking to a model are 502. */
export function statusFor(e: unknown): number {
  if (e instanceof HttpError) return e.status;
  if (e instanceof QuotaError) return 429;
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

/**
 * What a caller is told about a failure. Messages from the errors above name variables, never values, so they are
 * shown as they are. Anything else (a file system error, a bug) can carry server paths, so on a public server it is
 * replaced by a generic line and the detail goes to the operator's log only.
 */
export function publicMessage(e: unknown, hideInternals: boolean): string {
  const err = e as Error;
  if (!hideInternals || statusFor(e) !== 500) return err.message;
  process.stderr.write(`internal error: ${err.stack ?? err.message}\n`);
  return GENERIC;
}
