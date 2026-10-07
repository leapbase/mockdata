import { BusyError, QuotaError } from "@mockdata/core";
import { UserError } from "@mockdata/cli";
import { CycleError, GenerationError, SchemaError, ValidationError } from "@mockdata/core";
import { LlmCancelledError, LlmConfigError, LlmFillError, LlmHttpError } from "@mockdata/llm";
import { describe, expect, it } from "vitest";
import { decodeError, encodeError, JobTimeoutError } from "../src/workers/errors.js";
import { publicMessage, statusFor } from "../src/errors.js";

const cases: [string, Error, number][] = [
  ["UserError", new UserError("bad input"), 400],
  ["SchemaError", new SchemaError("bad schema"), 400],
  ["CycleError", new CycleError(["a", "b"]), 400],
  ["GenerationError", new GenerationError("could not generate"), 400],
  ["ValidationError", new ValidationError(["v1", "v2"]), 400],
  ["LlmConfigError", new LlmConfigError("No provider"), 400],
  ["LlmFillError", new LlmFillError("bad reply"), 502],
  ["LlmHttpError", new LlmHttpError("upstream said no", 500), 502],
  ["LlmCancelledError", new LlmCancelledError(), 500],
  ["QuotaError", new QuotaError("over the limit"), 429],
  ["BusyError", new BusyError("busy"), 503],
  ["JobTimeoutError", new JobTimeoutError(5), 504],
  ["plain Error", new Error("boom"), 500],
];

describe("errors survive a thread boundary as the same kind of error", () => {
  it.each(cases)("%s keeps its class, message and HTTP status after encode -> structured clone -> decode", (_label, err, status) => {
    const wire = structuredClone(encodeError(err)); // what postMessage does
    expect(wire).toEqual({ kind: expect.any(String), name: err.name, message: err.message });
    const back = decodeError(wire);
    expect(back).toBeInstanceOf(err.constructor);
    expect(back.message).toBe(err.message);
    expect(statusFor(back)).toBe(status);
    expect(statusFor(back)).toBe(statusFor(err));
  });

  it("does not rely on `name`: classes that never set it are still told apart", () => {
    expect(new UserError("x").name).toBe("Error"); // the trap a name-based lookup would fall into
    expect(decodeError(encodeError(new UserError("x")))).toBeInstanceOf(UserError);
    expect(decodeError(encodeError(new Error("x")))).not.toBeInstanceOf(UserError);
  });

  it("never sends a stack or other fields, only kind, name and message", () => {
    const err = Object.assign(new UserError("x"), { secret: "s3cret", stack: "at /srv/app/file.ts:1" });
    expect(Object.keys(encodeError(err)).sort()).toEqual(["kind", "message", "name"]);
  });

  it("turns anything thrown (a string, null, an object) into an ordinary error", () => {
    expect(decodeError(encodeError("just a string")).message).toBe("just a string");
    expect(decodeError(encodeError(null)).message).toMatch(/unknown/i);
    expect(statusFor(decodeError(encodeError({ weird: true })))).toBe(500);
  });
});

describe("pool errors map to gateway statuses with public messages that reveal nothing", () => {
  it("answers 503 for a full queue and 504 for a job that ran too long", () => {
    expect(statusFor(new BusyError("x"))).toBe(503);
    expect(statusFor(new JobTimeoutError(120))).toBe(504);
    expect(publicMessage(new BusyError("internal detail"), true)).toMatch(/busy/i);
    expect(publicMessage(new JobTimeoutError(120), true)).toMatch(/too long/i);
    expect(publicMessage(new BusyError("internal detail"), true)).not.toContain("internal detail");
  });
  it("keeps the real message for the operator in local mode", () => {
    expect(publicMessage(new JobTimeoutError(7), false)).toMatch(/7/);
  });
});
