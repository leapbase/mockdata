import { parseSchemaText } from "@mockdata/cli";
import { CycleError, generate, llmColumns, parseSchema, planGeneration, SchemaError, type DataSchemaT } from "@mockdata/core";
import { optInt, optStringArray, readJson, reqString, sendJson, type Handler } from "../http.js";
import { applyRowOverride, buildPreview } from "../preview.js";

/** Schema text from the editor. YAML is a superset of JSON, so one parser handles both. */
export function parseSchemaBody(body: Record<string, unknown>): DataSchemaT {
  return parseSchema(parseSchemaText(reqString(body, "text")));
}

export const validateRoute: Handler = async (_ctx, req, res) => {
  const body = await readJson(req);
  const text = reqString(body, "text");
  try {
    const schema = parseSchema(parseSchemaText(text));
    const plan = planGeneration(schema);
    sendJson(res, 200, {
      ok: true,
      tables: Object.entries(schema.tables).map(([name, t]) => ({ name, rows: t.rows, columns: Object.keys(t.columns) })),
      order: plan.levels,
      deferred: plan.deferred,
      llmColumns: llmColumns(schema).map((c) => `${c.table}.${c.column}`),
    });
  } catch (e) {
    const err = e as Error & { linePos?: { line: number }[] };
    if (err.name === "YAMLParseError") {
      sendJson(res, 200, { ok: false, errors: [{ message: err.message.split("\n")[0], line: err.linePos?.[0]?.line }] });
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

export const generateRoute: Handler = async (_ctx, req, res) => {
  const { schema, seed, previewRows, tables } = readRunParams(await readJson(req));
  // llm columns stay pending here; the stream route fills them.
  const data = generate(schema, { seed, deferLlm: true });
  sendJson(res, 200, buildPreview(schema, data, { seed, rows: previewRows, tables }));
};
