import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { assertWithinDiskQuota } from "@mockdata/accounts";
import { assertNotSymlink, assertRowBudget, resolveInside, UserError, writeFileConfined } from "@mockdata/cli";
import { LlmCancelledError } from "@mockdata/llm";
import { beginRun } from "../accounts/guards.js";
import { abortOnClose, HttpError, optBool, optEnum, optInt, optString, readJson, sendJson, type Handler } from "../http.js";
import { parseSchemaBody } from "./run.js";

const FORMATS = ["json", "ndjson", "csv"] as const;

/** Generate every row (LLM columns included) and either write files under the root or return a zip. */
export const exportRoute: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  const parsed = parseSchemaBody(body);
  assertRowBudget(parsed);
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
    targets = Object.keys(parsed.tables).map((table) => ({ table, file: path.join(dir, `${table}.${format}`) }));
    for (const t of targets) assertNotSymlink(t.file);
    const clashes = targets.filter((t) => existsSync(t.file));
    if (clashes.length > 0 && !overwrite) {
      throw new UserError(`Refusing to overwrite existing files: ${clashes.map((t) => path.relative(ctx.root, t.file).split(path.sep).join("/")).join(", ")} (tick "Overwrite" to replace them)`);
    }
  }

  const run = await beginRun(ctx, parsed); // row cap, daily LLM budget and run slot (accounts mode)
  const schema = run.schema;

  // A closed connection (dialog or tab closed) stops the model calls and writes nothing. The slot is held until
  // generation, serializing and zipping are all done.
  let result;
  try {
    result = await ctx.runner.run({ kind: "export", schema, seed, format, zip: wantZip, env: ctx.env() }, { signal: abortOnClose(res) });
  } catch (e) {
    if (e instanceof LlmCancelledError) return;
    throw e;
  } finally {
    run.done();
  }
  const { counts, report } = result;

  if (wantZip) {
    const archive = Buffer.from(result.archive!.buffer, result.archive!.byteOffset, result.archive!.byteLength);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="mockdata.zip"',
      "content-length": archive.length,
      "cache-control": "no-store",
    });
    res.end(archive);
    return;
  }

  const texts = new Map(targets.map(({ table }) => [table, result.texts![table]!]));
  if (ctx.accounts) {
    // Refuse before writing anything if the files would not fit in this user's storage (replacing a file frees its old size).
    const incoming = [...texts.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);
    const replaced = targets.reduce((n, { file }) => n + (existsSync(file) ? lstatSync(file).size : 0), 0);
    assertWithinDiskQuota(ctx.root, Math.max(0, incoming - replaced), ctx.accounts.limits.userQuotaBytes, {
      newFiles: targets.filter(({ file }) => !existsSync(file)).length,
      maxFiles: ctx.accounts.limits.maxFiles,
    });
  }

  const files: string[] = [];
  for (const { table, file } of targets) {
    writeFileConfined(ctx.root, file, texts.get(table)!, { overwrite });
    files.push(path.relative(ctx.root, file).split(path.sep).join("/"));
  }
  sendJson(res, 200, {
    files,
    rows: counts,
    ...(report.calls > 0 ? { llm: report } : {}),
  });
};
