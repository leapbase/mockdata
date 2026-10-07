import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePublicUrl } from "@mockdata/cli";
import { QuotaError } from "@mockdata/core";
import { HttpError } from "../src/http.js";
import type { HostedPlugin, Policy } from "../src/hosted.js";
import { SHOP_YAML, boot, tmpRoot } from "./helpers.js";

/** A policy that allows everything; tests override the one rule they care about. */
const open = (over: Partial<Policy> = {}): Policy => ({
  hideInternals: false,
  lockedModels: false,
  allowDatabase: true,
  lockLlm: (cfg) => cfg,
  throttleRun: async () => undefined,
  throttleValidate: async () => undefined,
  checkSchema: () => undefined,
  checkRun: () => undefined,
  beginRun: async (schema) => ({ schema, done: () => undefined }),
  checkWrite: () => undefined,
  ...over,
});

/**
 * A hosted layer with no accounts code at all: the caller is named by an `x-user` header and works in
 * `<users>/<name>`. If this passes, the server's seam is complete without `@mockdata/accounts`.
 */
function fakePlugin(users: string, over: { policy?: Partial<Policy>; bodyMax?: number; mcp?: HostedPlugin["mcp"] } = {}) {
  const calls = { handleApi: [] as string[], done: 0 };
  const plugin: HostedPlugin = {
    publicUrl: parsePublicUrl("https://hosted.example.com"),
    bodyMax: over.bodyMax ?? 64 * 1024,
    responseHeaders: () => ({ "x-hosted": "yes" }),
    mcp: over.mcp ?? (() => ({ handle: async (_req, res) => void res.writeHead(200).end("mcp ok") })),
    async handleApi(req, res, url) {
      calls.handleApi.push(url.pathname);
      if (url.pathname !== "/api/auth/ping") return false;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pong: true }));
      return true;
    },
    async contextFor(base, req) {
      const name = req.headers["x-user"];
      if (typeof name !== "string") throw new HttpError(401, "Sign in required");
      const root = join(users, name);
      mkdirSync(root, { recursive: true });
      return {
        ...base,
        root,
        policy: open({
          ...over.policy,
          beginRun: async (schema) => ({ schema, done: () => void calls.done++ }),
        }),
      };
    },
  };
  return { plugin, calls };
}

const as = (name: string) => ({ "x-user": name });

describe("HostedPlugin: the seam between the open server and a hosted layer", () => {
  it("asks the plugin who the caller is, and refuses everyone it does not name", async () => {
    const users = tmpRoot();
    const app = await boot({ hosted: fakePlugin(users).plugin });
    expect((await app.call("GET", "/api/files")).status).toBe(401);
    expect((await app.call("GET", "/api/files", undefined, as("ann"))).status).toBe(200);
  });

  it("runs each caller in the folder the plugin chose, not the server root", async () => {
    const users = tmpRoot();
    const app = await boot({ hosted: fakePlugin(users).plugin });
    const put = await app.call("PUT", "/api/file", { path: "mine.yaml", text: SHOP_YAML, create: true }, as("ann"));
    expect(put.status).toBe(200);
    expect(existsSync(join(users, "ann", "mine.yaml"))).toBe(true);
    expect(existsSync(join(app.root, "mine.yaml"))).toBe(false);
    const bobs = await app.call("GET", "/api/files", undefined, as("bob"));
    expect(JSON.stringify(bobs.json)).not.toContain("mine.yaml");
  });

  it("lets the plugin answer its own /api/ routes and passes everything else through", async () => {
    const { plugin, calls } = fakePlugin(tmpRoot());
    const app = await boot({ hosted: plugin });
    expect((await app.call("GET", "/api/auth/ping")).json).toEqual({ pong: true });
    expect((await app.call("GET", "/api/nope", undefined, as("ann"))).status).toBe(404);
    expect(calls.handleApi).toEqual(["/api/auth/ping", "/api/nope"]);
  });

  it("adds the plugin's response headers and hands /mcp to the plugin", async () => {
    const app = await boot({ hosted: fakePlugin(tmpRoot()).plugin });
    const api = await app.call("GET", "/api/config", undefined, as("ann"));
    expect(api.headers.get("x-hosted")).toBe("yes");
    const mcp = await app.call("POST", "/mcp", {});
    expect(mcp.status).toBe(200);
    expect(mcp.raw).toBe("mcp ok");
  });

  it("refuses a body over the plugin's limit before the route reads it", async () => {
    const app = await boot({ hosted: fakePlugin(tmpRoot(), { bodyMax: 1000 }).plugin });
    const big = await app.call("POST", "/api/validate", { text: "x".repeat(5000) }, as("ann"));
    expect(big.status).toBe(413);
  });

  it("applies the caller's policy: throttles, write limits and database access", async () => {
    const plugin = fakePlugin(tmpRoot(), {
      policy: {
        allowDatabase: false,
        throttleValidate: async () => {
          throw new QuotaError("too fast");
        },
        checkWrite: () => {
          throw new HttpError(413, "over quota");
        },
      },
    }).plugin;
    const app = await boot({ hosted: plugin });
    const validate = await app.call("POST", "/api/validate", { text: SHOP_YAML }, as("ann"));
    expect(validate.status).toBe(429);
    expect(validate.json.error.message).toBe("too fast");
    expect((await app.call("PUT", "/api/file", { path: "a.yaml", text: SHOP_YAML, create: true }, as("ann"))).status).toBe(413);
    const infer = await app.call("POST", "/api/infer", { connectionEnv: "DATABASE_URL" }, as("ann"));
    expect(infer.status).toBe(400);
    expect((await app.call("GET", "/api/config", undefined, as("ann"))).json.dbEnv).toEqual([]);
  });

  it("holds a run's ticket for the whole run and releases it", async () => {
    const { plugin, calls } = fakePlugin(tmpRoot());
    const app = await boot({ hosted: plugin });
    const out = await app.call("POST", "/api/export", { text: SHOP_YAML, format: "csv", zip: true }, as("ann"));
    expect(out.status).toBe(200);
    expect(calls.done).toBe(1);
  });

  it("without a plugin the server stays the local workspace: no policy, no sign-in", async () => {
    const app = await boot();
    expect((await app.call("GET", "/api/files")).status).toBe(200);
    expect((await app.call("GET", "/api/auth/me")).json.auth.accountsEnabled).toBe(false);
  });
});
