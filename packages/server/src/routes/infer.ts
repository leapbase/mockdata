import { inferConfined, toYaml } from "@mockdata/cli";
import { HttpError, optBool, optEnum, optInt, optString, readJson, sendJson, type Handler } from "../http.js";

/** Build a draft schema from a file under the root, pasted content, or a database named by env var. */
export const inferRoute: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  await ctx.policy?.throttleRun();
  // A variable named by a visitor would read the operator's database (catalog only, but still theirs to keep private).
  if (ctx.policy?.allowDatabase === false && optString(body, "connectionEnv") !== undefined) throw new HttpError(400, "Inferring from a database is not available on this server");
  const result = await inferConfined(ctx.root, ctx.env(), {
    path: optString(body, "path"),
    content: optString(body, "content"),
    name: optString(body, "name"),
    connectionEnv: optString(body, "connectionEnv"),
    kind: optEnum(body, "kind", ["json-schema", "sample", "database"] as const),
    rows: optInt(body, "rows", 0, 10_000_000),
    pgSchema: optString(body, "pgSchema"),
    enums: optBool(body, "enums"),
  });
  sendJson(res, 200, {
    schemaText: toYaml(result.schema),
    tables: Object.keys(result.schema.tables),
    warnings: result.warnings,
  });
};
