import { inferConfined, toYaml } from "@mockdata/cli";
import { abortOnClose, HttpError, optBool, optEnum, optInt, optString, readJson, sendJson, type Handler } from "../http.js";

/** Build a draft schema from a file under the root, pasted content, or a database named by env var. */
export const inferRoute: Handler = async (ctx, req, res) => {
  const body = await readJson(req);
  await ctx.policy?.throttleRun();
  // A variable named by a visitor would read the operator's database (catalog only, but still theirs to keep private).
  if (ctx.policy?.allowDatabase === false && optString(body, "connectionEnv") !== undefined) throw new HttpError(400, "Inferring from a database is not available on this server");
  const args = {
    path: optString(body, "path"),
    content: optString(body, "content"),
    name: optString(body, "name"),
    kind: optEnum(body, "kind", ["json-schema", "sample", "database"] as const),
    rows: optInt(body, "rows", 0, 10_000_000),
    pgSchema: optString(body, "pgSchema"),
    enums: optBool(body, "enums"),
  };
  const connectionEnv = optString(body, "connectionEnv");
  if (connectionEnv !== undefined) {
    // A database is reflected over the network (waiting, not computing), and needs the environment: stay here.
    const result = await inferConfined(ctx.root, ctx.env(), { ...args, connectionEnv });
    return sendJson(res, 200, { schemaText: toYaml(result.schema), tables: Object.keys(result.schema.tables), warnings: result.warnings });
  }
  // Files and pasted samples are parsed and analysed off the event loop, with the pool's queue and time limit.
  sendJson(res, 200, await ctx.runner.run({ kind: "infer", root: ctx.root, args }, { signal: abortOnClose(res) }));
};
