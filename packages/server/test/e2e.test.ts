import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot } from "./helpers.js";

const examples = join(__dirname, "../../../examples");

describe("end to end on examples/shop.yaml", () => {
  it("open, validate, preview, save, export", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "mockdata-e2e-")));
    copyFileSync(join(examples, "shop.yaml"), join(root, "shop.yaml"));
    const staticDir = join(root, "web");
    mkdirSync(staticDir);
    writeFileSync(join(staticDir, "index.html"), "<title>mockdata</title>");
    const { get, post, put } = await boot({ root, staticDir });

    expect((await get("/")).raw).toContain("mockdata");
    const files = (await get("/api/files")).json.files as string[];
    expect(files).toContain("shop.yaml");

    const { text } = (await get("/api/file?path=shop.yaml")).json;
    const check = (await post("/api/validate", { text })).json;
    expect(check.ok).toBe(true);
    expect(check.order.flat().length).toBe(check.tables.length);

    const preview = (await post("/api/generate", { text, previewRows: 5 })).json;
    for (const t of Object.values<any>(preview.tables)) expect(t.rows.length).toBeLessThanOrEqual(5);

    expect((await put("/api/file", { path: "copy.yaml", text, create: true })).status).toBe(200);
    expect(readFileSync(join(root, "copy.yaml"), "utf8")).toBe(text);

    const out = await post("/api/export", { text, format: "csv", outputDir: "out" });
    expect(out.status).toBe(200);
    for (const f of out.json.files as string[]) expect(existsSync(join(root, f))).toBe(true);
  });
});
