import { parseSchemaText, UserError } from "@mockdata/cli";
import { CycleError, llmColumns, parseSchema, planGeneration, SchemaError, type DataSchemaT } from "@mockdata/core";
import { LlmCancelledError } from "@mockdata/llm";
import { beginRun } from "../hosted.js";
import { publicMessage, statusFor } from "../errors.js";
import { llmStatus } from "./config.js";
import { abortOnClose, optInt, optStringArray, readJson, reqString, sendJson, type Handler } from "../http.js";
import { applyRowOverride } from "../preview.js";

/** Schema text from the editor. YAML is a superset of JSON, so one parser handles both. */
export function parseSchemaBody(body: Record<string, unknown>): DataSchemaT {
  return parseSchema(parseText(reqString(body, "text")));
}

/** The yaml library throws more than YAMLParseError (an unresolved alias is a ReferenceError): all of it is bad input. */
function parseText(text: string): unknown {
  try {
    return parseSchemaText(text);
  } catch (e) {
    const err = e as Error & { linePos?: { line: number }[] };
    throw Object.assign(new UserError(err.message.split("\n")[0]!), { linePos: err.linePos });
  }
}

export const validateRoute: Handler = async (ctx, req, res) => {
  await ctx.policy?.throttleValidate();
  const body = await readJson(req);
  const text = reqString(body, "text");
  try {
    const schema = parseSchema(parseText(text));
    ctx.policy?.checkSchema(schema);
    const plan = planGeneration(schema);
    sendJson(res, 200, {
      ok: true,
      tables: Object.entries(schema.tables).map(([name, t]) => ({ name, rows: t.rows, columns: Object.keys(t.columns) })),
      diagram: { tables: Object.entries(schema.tables).map(([name, t]) => ({
        name, rows: t.rows,
        columns: Object.entries(t.columns).map(([name, c]) => ({
          name, type: c.type, primaryKey: !!c.primaryKey, unique: !!c.unique,
          nullable: !!c.nullable, ...(c.ref ? { ref: c.ref } : {}),
        })),
      })) },
      order: plan.levels,
      deferred: plan.deferred,
      llmColumns: llmColumns(schema).map((c) => `${c.table}.${c.column}`),
      llm: llmStatus(ctx, schema.llm),
    });
  } catch (e) {
    const err = e as Error & { linePos?: { line: number }[] };
    if (e instanceof UserError) {
      sendJson(res, 200, { ok: false, errors: [{ message: err.message, line: err.linePos?.[0]?.line }] });
    } else if (e instanceof SchemaError || e instanceof CycleError) {
      sendJson(res, 200, { ok: false, errors: [{ message: err.message }] });
    } else {
      throw e;
    }
  }
};

export interface RunParams {
  schema: DataSchemaT;
  seed?: number;
  previewRows: number;
  tables?: string[];
}

/** Fields shared by the preview and stream routes. */
export function readRunParams(body: Record<string, unknown>): RunParams {
  const schema = applyRowOverride(parseSchemaBody(body), optInt(body, "rows", 0, 10_000_000));
  return {
    schema,
    seed: optInt(body, "seed", -2_147_483_648, 2_147_483_647),
    previewRows: optInt(body, "previewRows", 0, 200) ?? 50,
    tables: optStringArray(body, "tables"),
  };
}

export const generateRoute: Handler = async (ctx, req, res) => {
  const { schema, seed, previewRows, tables } = readRunParams(await readJson(req));
  await ctx.policy?.throttleRun();
  ctx.policy?.checkRun(schema);
  // llm columns stay pending here; the stream route fills them.
  const { preview } = await ctx.runner.run({ kind: "preview", schema, seed, previewRows, tables }, { signal: abortOnClose(res) });
  sendJson(res, 200, preview);
};

/**
 * Fill llm columns and stream progress as server-sent events. The client
 * reads this with fetch (POST carries the schema text). Closing the
 * connection aborts the run before the next model request.
 */
export const streamRoute: Handler = async (ctx, req, res) => {
  const params = readRunParams(await readJson(req));
  const { seed, previewRows, tables } = params;
  const run = await beginRun(ctx, params.schema); // row cap, daily LLM budget and run slot (hosted); refused with a plain 429/400 before any stream starts
  const schema = run.schema;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const signal = abortOnClose(res);
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const { preview, report } = await ctx.runner.run({ kind: "run", schema, seed, previewRows, tables, env: ctx.env() }, { signal, onProgress: (p) => send("progress", p) });
    send("done", { ...preview, report });
  } catch (e) {
    // A cancelled run has no listener left; anything else is reported (messages name variables, never values).
    if (!(e instanceof LlmCancelledError)) send("error", { name: statusFor(e) >= 500 && ctx.policy?.hideInternals ? "Error" : (e as Error).name, message: publicMessage(e, !!ctx.policy?.hideInternals) });
  } finally {
    run.done();
    res.end();
  }
};
