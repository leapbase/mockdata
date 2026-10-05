// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { stubApi, sseResponse } from "./stub";

vi.mock("../src/components/Editor", () => ({ default: ({ value, onChange }: any) =>
  <textarea aria-label="schema" value={value} onChange={(e) => onChange(e.target.value)} /> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const valid = { ok: true, tables: [{ name: "people", rows: 2, columns: ["id"] }], order: [["people"]], deferred: [], llmColumns: [],
  diagram: { tables: [{ name: "people", rows: 2, columns: [{ name: "id", type: "integer", primaryKey: true, unique: false, nullable: false }] }] } };
function setup(extra = {}) {
  return stubApi({ "GET /api/files": () => ({ files: ["people.yaml"] }), "GET /api/config": () => ({ llm: { ok: true, provider: "ollama:test" }, dbEnv: [] }),
    "POST /api/validate": () => valid, ...extra });
}
describe("workspace navigation", () => {
  it("shows a retry action when diagram validation cannot reach the server", async () => {
    let attempts = 0;
    setup({ "POST /api/validate": () => { if (++attempts === 1) throw new Error("Validation offline"); return { ok: false, errors: [{ message: "Bad schema" }] }; } });
    render(<App debounceMs={0} />);
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("tab", { name: "Diagram" }));
    await userEvent.click(await screen.findByRole("button", { name: "Retry validation" }));
    expect(await screen.findByText("Fix the schema in the editor to view its diagram.")).toBeTruthy();
    expect(attempts).toBe(2);
  });
  it("asks before applying an import when edits were made during inference", async () => {
    let finish: (r: unknown) => void = () => {};
    setup({ "POST /api/infer": () => new Promise((resolve) => { finish = resolve; }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("tab", { name: "Import" }));
    await userEvent.type(screen.getByLabelText("Path under the folder"), "source.csv");
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    await userEvent.type(screen.getByLabelText("schema"), "# my new edits");
    finish({ schemaText: "tables: {}", tables: [], warnings: [] });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toContain("# my new edits");
    confirm.mockRestore();
  });
  it("filters the schema list from the search box and clears it", async () => {
    setup({ "GET /api/files": () => ({ files: ["people.yaml", "shop.yaml", "shop-llm.yaml"] }) });
    render(<App debounceMs={0} />);
    await screen.findByRole("button", { name: "people.yaml" });
    const box = screen.getByLabelText("Search schemas");
    await userEvent.type(box, "SHOP");
    expect(screen.queryByRole("button", { name: "people.yaml" })).toBeNull();
    expect(screen.getByRole("button", { name: "shop-llm.yaml" })).toBeTruthy();
    expect(screen.getByText(/2 of 3 saved schemas/)).toBeTruthy();
    await userEvent.type(box, "zzz");
    expect(screen.getByText(/No schemas match/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("button", { name: "people.yaml" })).toBeTruthy();
  });
  it("cancels an ordinary generation request", async () => {
    let signal: AbortSignal | undefined;
    setup({ "POST /api/generate": (_b: any, _u: any, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal as AbortSignal;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }) });
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled/i);
  });
  it("supports arrow-key navigation between sidebar tabs", async () => {
    setup();
    render(<App debounceMs={0} />);
    const schemas = screen.getByRole("tab", { name: "Schemas" });
    schemas.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Import" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Import" }));
  });
  it("closes mobile generation with Escape and restores focus to its opener", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    setup();
    render(<App debounceMs={0} />);
    const opener = screen.getByRole("button", { name: "Generate data" });
    await userEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Data generation" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("starts with generation closed and preserves settings and results when reopened", async () => {
    setup({ "POST /api/generate": () => ({ seed: 42, counts: { people: 1 }, pending: [], tables: { people: { columns: ["id"], refs: {}, rows: [{ id: 7 }] } } }) });
    render(<App debounceMs={0} />);
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    await userEvent.type(screen.getByLabelText("Seed"), "42");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("tab", { name: /^people / })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Collapse generation panel" }));
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("42");
    expect(screen.getByRole("tab", { name: /^people / })).toBeTruthy();
  });
  it("imports in the sidebar and returns to Schemas with an unsaved draft", async () => {
    setup({ "POST /api/infer": () => ({ schemaText: "tables: {}", tables: [], warnings: ["Skipped nested object"] }) });
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("tab", { name: "Import" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste" }));
    await userEvent.type(screen.getByLabelText("Sample or schema text"), "id,name");
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Schemas" }).getAttribute("aria-selected")).toBe("true"));
    expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toBe("tables: {}");
    expect(screen.getByText("Skipped nested object")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps edited text across diagram view and explains invalid schemas", async () => {
    setup({ "POST /api/validate": (body: any) => body.text.includes("broken") ? { ok: false, errors: [{ message: "Invalid schema" }] } : valid });
    render(<App debounceMs={0} />);
    await userEvent.type(screen.getByLabelText("schema"), "broken");
    await userEvent.click(screen.getByRole("tab", { name: "Diagram" }));
    expect(await screen.findByText("Fix the schema in the editor to view its diagram.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Return to editor" }));
    expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toContain("broken");
  });
  it("does not abort an LLM run when the panel is collapsed", async () => {
    let signal: AbortSignal | undefined;
    setup({ "POST /api/generate/stream": (_b: any, _u: any, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return sseResponse([{ event: "progress", data: { column: "people.note", done: 1, total: 2, calls: 1, inputTokens: 1, outputTokens: 2 } }], { signal });
    } });
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    await waitFor(() => expect((screen.getByLabelText(/Fill LLM columns/) as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(screen.getByLabelText(/Fill LLM columns/));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("button", { name: "Cancel" });
    await userEvent.click(screen.getByRole("button", { name: "Collapse generation panel" }));
    expect(signal?.aborted).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Generate data (running)" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
