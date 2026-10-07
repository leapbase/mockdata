import { UserError } from "@mockdata/cli";
import { BusyError, CycleError, GenerationError, SchemaError, QuotaError, ValidationError } from "@mockdata/core";
import { LlmCancelledError, LlmConfigError, LlmFillError, LlmHttpError } from "@mockdata/llm";

/** A job ran past its time limit and its worker was stopped. */
export class JobTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`The job ran for more than ${seconds} seconds and was stopped`);
    this.name = "JobTimeoutError";
  }
}

/**
 * What an error looks like after crossing a thread boundary. Structured clone keeps an Error's message but loses its
 * class, and several of our classes never set `name` (it is just "Error"), so the class is sent as an explicit `kind`.
 * Nothing else goes: no stack (it holds server paths) and no extra fields.
 */
export interface WireError {
  kind: string;
  name: string;
  message: string;
}

/** Order matters only between classes that extend one another; none of these do. */
const KINDS: [string, new (...args: never[]) => Error][] = [
  ["user", UserError],
  ["schema", SchemaError],
  ["cycle", CycleError],
  ["generation", GenerationError],
  ["validation", ValidationError],
  ["llmConfig", LlmConfigError],
  ["llmFill", LlmFillError],
  ["llmHttp", LlmHttpError],
  ["llmCancelled", LlmCancelledError],
  ["quota", QuotaError],
  ["busy", BusyError],
  ["timeout", JobTimeoutError],
];

export function encodeError(e: unknown): WireError {
  if (e instanceof Error) {
    const kind = KINDS.find(([, cls]) => e instanceof cls)?.[0] ?? "other";
    return { kind, name: e.name, message: e.message };
  }
  return { kind: "other", name: "Error", message: typeof e === "string" ? e : "Unknown error in a worker" };
}

/** A real instance of the original class (built without its constructor, which may need arguments). */
export function decodeError(wire: WireError): Error {
  const cls = KINDS.find(([kind]) => kind === wire.kind)?.[1];
  if (!cls) return Object.assign(new Error(wire.message), { name: wire.name });
  const err = Object.create(cls.prototype) as Error;
  Object.defineProperties(err, {
    message: { value: wire.message, writable: true, configurable: true },
    name: { value: wire.name, writable: true, configurable: true },
    stack: { value: `${wire.name}: ${wire.message}`, writable: true, configurable: true },
  });
  return err;
}
