import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot, SHOP_YAML, tmpRoot } from "./helpers.js";

describe("GET /api/files", () => {
  it("lists schema files (yaml/json that define tables), skipping .env, dot-dirs and node_modules", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "shop.yaml"), SHOP_YAML);
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "hr.json"), '{"tables": {}}');
    writeFileSync(join(root, "package.json"), '{"name": "x"}');
    writeFileSync(join(root, "notes.yaml"), "hello: world\n");
    writeFileSync(join(root, ".env.yaml"), "tables:\n");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "dep.yaml"), "tables:\n");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "x.yaml"), "tables:\n");
    const { get } = await boot({ root });
    expect((await get("/api/files")).json.files).toEqual(["shop.yaml", "sub/hr.json"]);
  });

  it("does not follow symlinked directories out of the root", async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFileSync(join(outside, "leak.yaml"), SHOP_YAML);
    symlinkSync(outside, join(root, "link"));
    const { get } = await boot({ root });
    expect((await get("/api/files")).json.files).toEqual([]);
  });
});

describe("GET /api/file", () => {
  it("reads a schema file", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "shop.yaml"), SHOP_YAML);
    const { get } = await boot({ root });
    const r = await get("/api/file?path=shop.yaml");
    expect(r.json).toEqual({ path: "shop.yaml", text: SHOP_YAML });
  });

  it.each([
    ["../outside.yaml", /outside/],
    ["/etc/passwd", /relative|must be a \.yaml/],
    [".env", /must be a \.yaml/],
    ["notes.txt", /must be a \.yaml/],
    ["missing.yaml", /No such file/],
  ])("refuses %s", async (p, message) => {
    const { get } = await boot({ root: tmpRoot() });
    const r = await get(`/api/file?path=${encodeURIComponent(p)}`);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(message);
  });

  it("refuses an absolute path to a schema-looking file", async () => {
    const { get } = await boot({ root: tmpRoot() });
    const r = await get(`/api/file?path=${encodeURIComponent("/etc/x.yaml")}`);
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/relative/);
  });

  it("refuses a symlink that points outside the root", async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFileSync(join(outside, "secret.yaml"), "tables:\n");
    symlinkSync(join(outside, "secret.yaml"), join(root, "s.yaml"));
    const { get } = await boot({ root });
    const r = await get("/api/file?path=s.yaml");
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/outside/);
  });

  it("needs a path", async () => {
    const { get } = await boot();
    expect((await get("/api/file")).status).toBe(400);
  });
});

describe("PUT /api/file", () => {
  it("saves over an existing schema and creates folders for new ones", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "shop.yaml"), "old");
    const { put } = await boot({ root });
    expect((await put("/api/file", { path: "shop.yaml", text: SHOP_YAML })).status).toBe(200);
    expect(readFileSync(join(root, "shop.yaml"), "utf8")).toBe(SHOP_YAML);
    expect((await put("/api/file", { path: "new/dir/a.yaml", text: "x", create: true })).status).toBe(200);
    expect(readFileSync(join(root, "new/dir/a.yaml"), "utf8")).toBe("x");
  });

  it("create:true refuses to replace an existing file", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "a.yaml"), "keep");
    const { put } = await boot({ root });
    const r = await put("/api/file", { path: "a.yaml", text: "x", create: true });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/already exists/);
    expect(readFileSync(join(root, "a.yaml"), "utf8")).toBe("keep");
  });

  it.each(["../x.yaml", ".env", "x.sh", "/tmp/x.yaml"])("refuses to write %s", async (p) => {
    const root = tmpRoot();
    const { put } = await boot({ root });
    const r = await put("/api/file", { path: p, text: "x" });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "..", "x.yaml"))).toBe(false);
  });

  it("requires JSON", async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/api/file`, { method: "PUT", headers: { "content-type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
  });
});

describe("symlink escapes", () => {
  it("does not read .env through a schema-named symlink", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, ".env"), "SECRET_KEY=abc123\n");
    symlinkSync(join(root, ".env"), join(root, "cfg.yaml"));
    const { get } = await boot({ root });
    const r = await get("/api/file?path=cfg.yaml");
    expect(r.status).toBe(400);
    expect(r.raw).not.toContain("abc123");
  });

  it("does not write through a dangling symlink that points outside the root", async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    symlinkSync(join(outside, "pwned.yaml"), join(root, "evil.yaml"));
    const { put } = await boot({ root });
    const r = await put("/api/file", { path: "evil.yaml", text: "x", create: true });
    expect(r.status).toBe(400);
    expect(existsSync(join(outside, "pwned.yaml"))).toBe(false);
  });

  it("does not overwrite a live symlinked schema either", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "real.yaml"), "keep");
    symlinkSync(join(root, "real.yaml"), join(root, "link.yaml"));
    const { put } = await boot({ root });
    expect((await put("/api/file", { path: "link.yaml", text: "x" })).status).toBe(400);
    expect(readFileSync(join(root, "real.yaml"), "utf8")).toBe("keep");
  });
});

describe("POST /api/file/rename", () => {
  it("writes the text under the new name and removes the old file", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "shop.yaml"), "old");
    const { post } = await boot({ root });
    const r = await post("/api/file/rename", { from: "shop.yaml", to: "sub/store.yaml", text: SHOP_YAML });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ path: "sub/store.yaml" });
    expect(readFileSync(join(root, "sub", "store.yaml"), "utf8")).toBe(SHOP_YAML);
    expect(existsSync(join(root, "shop.yaml"))).toBe(false);
  });

  it("never overwrites an existing file and keeps the original", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "a.yaml"), "a");
    writeFileSync(join(root, "b.yaml"), "b");
    const { post } = await boot({ root });
    const r = await post("/api/file/rename", { from: "a.yaml", to: "b.yaml", text: "new" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/already exists/);
    expect(readFileSync(join(root, "a.yaml"), "utf8")).toBe("a");
    expect(readFileSync(join(root, "b.yaml"), "utf8")).toBe("b");
  });

  it.each([
    [{ from: "missing.yaml", to: "x.yaml" }, /No such file/],
    [{ from: "a.yaml", to: "a.yaml" }, /same/],
    [{ from: "a.yaml", to: "../out.yaml" }, /outside/],
    [{ from: "a.yaml", to: ".env" }, /must be a \.yaml/],
    [{ from: "../a.yaml", to: "x.yaml" }, /outside/],
    [{ from: "notes.txt", to: "x.yaml" }, /must be a \.yaml/],
  ])("refuses %j", async (paths, message) => {
    const root = tmpRoot();
    writeFileSync(join(root, "a.yaml"), "a");
    writeFileSync(join(root, "notes.txt"), "n");
    const { post } = await boot({ root });
    const r = await post("/api/file/rename", { ...paths, text: "t" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(message);
    expect(readFileSync(join(root, "a.yaml"), "utf8")).toBe("a");
    expect(existsSync(join(root, "x.yaml"))).toBe(false);
  });

  it("refuses to rename a symbolic link, leaving its target alone", async () => {
    const root = tmpRoot();
    const outside = tmpRoot();
    writeFileSync(join(outside, "real.yaml"), "keep");
    symlinkSync(join(outside, "real.yaml"), join(root, "link.yaml"));
    const { post } = await boot({ root });
    const r = await post("/api/file/rename", { from: "link.yaml", to: "x.yaml", text: "t" });
    expect(r.status).toBe(400);
    expect(existsSync(join(root, "x.yaml"))).toBe(false);
    expect(readFileSync(join(outside, "real.yaml"), "utf8")).toBe("keep");
  });
});
