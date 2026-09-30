import { existsSync } from "node:fs";
import path from "node:path";
import { assertNotSymlink, assertRowBudget, resolveInside, serialize, UserError, writeFileConfined } from "@mockdata/cli";
import { LlmCancelledError, generateWithLlm } from "@mockdata/llm";
import { HttpError, optBool, optEnum, optInt, optString, readJson, sendJson, type Handler } from "../http.js";
import { zip } from "../zip.js";
import { parseSchemaBody } from "./run.js";

const FORMATS = ["json", "ndjson", "csv"] as const;

/** Generate every row (LLM columns included) and either write files under the root or return a zip. */
export const exportRoute: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  const schema = parseSchemaBody(body);
  assertRowBudget(schema);
  const format = optEnum(body, "format", FORMATS) ?? "json";
  const outputDir = optString(body, "outputDir");
  const wantZip = optBool(body, "zip") ?? false;
  const overwrite = optBool(body, "overwrite") ?? false;
  const seed = optInt(body, "seed", -2_147_483_648, 2_147_483_647);
  if ((outputDir !== undefined) === wantZip) throw new HttpError(400, 'Provide exactly one of "outputDir" or "zip": true');

  // Decide where files go (and fail on conflicts) before spending any LLM calls.
  let targets: { table: string; file: string }[] = [];
  if (outputDir !== undefined) {
    const dir = resolveInside(ctx.root, outputDir);
    targets = Object.keys(schema.tables).map((table) => ({ table, file: path.join(dir, `${table}.${format}`) }));
    for (const t of targets) assertNotSymlink(t.file);
    const clashes = targets.filter((t) => existsSync(t.file));
    if (clashes.length > 0 && !overwrite) {
      throw new UserError(`Refusing to overwrite existing files: ${clashes.map((t) => path.relative(ctx.root, t.file).split(path.sep).join("/")).join(", ")} (tick "Overwrite" to replace them)`);
    }
  }

  // A closed connection (dialog or tab closed) stops the model calls and writes nothing.
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let generated;
  try {
    generated = await generateWithLlm(schema, { seed, ...ctx.llm, env: ctx.env(), signal: abort.signal });
  } catch (e) {
    if (e instanceof LlmCancelledError) return;
    throw e;
  }
  const { data, report } = generated;
  const text = (table: string) => serialize(data[table]!, Object.keys(schema.tables[table]!.columns), format);

  if (wantZip) {
    const archive = zip(Object.keys(schema.tables).map((table) => ({ name: `${table}.${format}`, data: Buffer.from(text(table)) })));
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="mockdata.zip"',
      "content-length": archive.length,
      "cache-control": "no-store",
    });
    res.end(archive);
    return;
  }

  const files: string[] = [];
  for (const { table, file } of targets) {
    writeFileConfined(ctx.root, file, text(table), { overwrite });
    files.push(path.relative(ctx.root, file).split(path.sep).join("/"));
  }
  sendJson(res, 200, {
    files,
    rows: Object.fromEntries(Object.entries(data).map(([t, r]) => [t, r.length])),
    ...(report.calls > 0 ? { llm: report } : {}),
  });
};
