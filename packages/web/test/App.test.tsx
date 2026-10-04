// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { errorResponse, sseResponse, stubApi } from "./stub";

// CodeMirror needs real layout; the App only depends on value/onChange/errors.
vi.mock("../src/components/Editor", () => ({
  default: ({ value, onChange, errors }: { value: string; onChange: (v: string) => void; errors: { message: string }[] }) => (
    <div>
      <textarea aria-label="schema" value={value} onChange={(e) => onChange(e.target.value)} />
      <ul aria-label="editor-errors">
        {errors.map((e, i) => (
          <li key={i}>{e.message}</li>
        ))}
      </ul>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

export const OK = { ok: true, tables: [{ name: "a", rows: 2, columns: ["id"] }], order: [["a"]], deferred: [], llmColumns: [] };
export const CONFIG_NO_LLM = { llm: { ok: false, reason: "No LLM provider: set AI_PROVIDER" }, dbEnv: [] };

async function renderWorkspace() {
  render(<App debounceMs={0} />);
  await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
}

describe("shell", () => {
  it("lists files, opens one into the editor, validates it and shows the summary", async () => {
    stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: ["shop.yaml", "hr.yaml"] }),
      "GET /api/file": (_b, url) => ({ path: url.searchParams.get("path"), text: "tables:\n  a: {}\n" }),
      "POST /api/validate": () => OK,
    });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "shop.yaml" }));
    await waitFor(() => expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toBe("tables:\n  a: {}\n"));
    expect(await screen.findByText(/1 table/)).toBeTruthy();
    expect(screen.getByText(/a/, { selector: ".order" })).toBeTruthy();
  });

  it("marks the file unsaved after an edit and saves it with PUT", async () => {
    const calls = stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: ["shop.yaml"] }),
      "GET /api/file": () => ({ path: "shop.yaml", text: "v1" }),
      "POST /api/validate": () => OK,
      "PUT /api/file": () => ({ path: "shop.yaml" }),
    });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "shop.yaml" }));
    await waitFor(() => expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toBe("v1"));
    expect(screen.queryByText("unsaved")).toBeNull();
    await userEvent.type(screen.getByLabelText("schema"), "!");
    expect(screen.getByText("unsaved")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("unsaved")).toBeNull());
    expect(calls.find((c) => c.key === "PUT /api/file")!.body).toEqual({ path: "shop.yaml", text: "v1!", create: false });
  });

  it("passes validation errors to the editor and the status strip", async () => {
    stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => ({ ok: false, errors: [{ message: "bad ref", line: 3 }] }),
    });
    await renderWorkspace();
    expect(await screen.findAllByText("bad ref")).toHaveLength(2);
  });

  it("creates a new file: asks for a name, adds .yaml, saves with create:true", async () => {
    const calls = stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => OK,
      "PUT /api/file": () => ({ path: "fresh.yaml" }),
    });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("New file name"), "fresh{Enter}");
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /api/file")).toBeTruthy());
    expect(calls.find((c) => c.key === "PUT /api/file")!.body).toMatchObject({ path: "fresh.yaml", create: true });
    expect(await screen.findByRole("button", { name: "fresh.yaml" })).toBeTruthy();
  });

  it("shows a failed request as a banner, not a crash", async () => {
    stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => {
        throw new Error("boom");
      },
      "POST /api/validate": () => OK,
    });
    await renderWorkspace();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("generate", () => {
  const PREVIEW = { seed: 1, counts: { a: 2 }, pending: [], tables: { a: { columns: ["id"], refs: {}, rows: [{ id: 1 }, { id: 2 }] } } };

  it("sends the editor text, seed and row override and shows the tables", async () => {
    const calls = stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => OK,
      "POST /api/generate": () => PREVIEW,
    });
    await renderWorkspace();
    await userEvent.type(await screen.findByLabelText("Seed"), "42");
    await userEvent.type(screen.getByLabelText("Rows per table"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("tab", { name: /^a / })).toBeTruthy();
    const body = calls.find((c) => c.key === "POST /api/generate")!.body;
    expect(body).toMatchObject({ seed: 42, rows: 3 });
    expect(typeof body.text).toBe("string");
  });

  it("shows the server's reason when generation fails and keeps the previous preview", async () => {
    let n = 0;
    stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => OK,
      "POST /api/generate": () => (++n === 1 ? PREVIEW : errorResponse(400, "Invalid schema: x")),
    });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "Generate" }));
    await screen.findByRole("tab", { name: /^a / });
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid schema: x");
    expect(screen.getByRole("tab", { name: /^a / })).toBeTruthy();
  });

  it("disables the LLM toggle with the server's reason", async () => {
    stubApi({ "GET /api/config": () => CONFIG_NO_LLM, "GET /api/files": () => ({ files: [] }), "POST /api/validate": () => OK });
    await renderWorkspace();
    const box = (await screen.findByLabelText(/Fill LLM columns/)) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });
});

describe("LLM run", () => {
  const CONFIG_LLM = { llm: { ok: true, provider: "ollama:m" }, dbEnv: [] };
  const FILLED = { seed: 1, counts: { notes: 5 }, pending: [], tables: { notes: { columns: ["id", "body"], refs: {}, rows: [{ id: 1, body: "hello" }] } } };
  const PROGRESS = { column: "notes.body", done: 2, total: 5, calls: 1, inputTokens: 10, outputTokens: 20 };

  it("streams progress, then shows the filled preview", async () => {
    const calls = stubApi({
      "GET /api/config": () => CONFIG_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => ({ ...OK, llmColumns: ["notes.body"] }),
      "POST /api/generate/stream": () => sseResponse([{ event: "progress", data: PROGRESS }, { event: "done", data: FILLED }], { end: true }),
    });
    await renderWorkspace();
    const box = (await screen.findByLabelText(/Fill LLM columns/)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(calls.some((c) => c.key === "POST /api/generate/stream")).toBe(true);
    expect(calls.some((c) => c.key === "POST /api/generate")).toBe(false);
  });

  it("shows live progress and Cancel aborts the request, keeping the previous preview", async () => {
    let signal: AbortSignal | undefined;
    stubApi({
      "GET /api/config": () => CONFIG_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => OK,
      "POST /api/generate": () => ({ seed: 1, counts: { a: 1 }, pending: [], tables: { a: { columns: ["id"], refs: {}, rows: [{ id: 1 }] } } }),
      "POST /api/generate/stream": (_b, _u, init) => {
        signal = init.signal as AbortSignal;
        return sseResponse([{ event: "progress", data: PROGRESS }], { signal });
      },
    });
    await renderWorkspace();
    // A first, plain run gives us a preview to keep.
    await userEvent.click(await screen.findByRole("button", { name: "Generate" }));
    await screen.findByRole("tab", { name: /^a / });

    const box = screen.getByLabelText(/Fill LLM columns/) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("status")).textContent).toContain("notes.body: 2 / 5");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(signal!.aborted).toBe(true));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled/i);
    expect(screen.getByRole("tab", { name: /^a / })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Generate" })).toBeTruthy();
  });

  it("shows a model failure from the stream", async () => {
    stubApi({
      "GET /api/config": () => CONFIG_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => OK,
      "POST /api/generate/stream": () => sseResponse([{ event: "error", data: { message: "model down" } }], { end: true }),
    });
    await renderWorkspace();
    const box = (await screen.findByLabelText(/Fill LLM columns/)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("alert")).textContent).toContain("model down");
  });
});

describe("infer", () => {
  const base = {
    "GET /api/config": () => ({ llm: { ok: false, reason: "r" }, dbEnv: ["DATABASE_URL"] }),
    "GET /api/files": () => ({ files: ["old.yaml"] }),
    "GET /api/file": () => ({ path: "old.yaml", text: "old" }),
    "POST /api/validate": () => OK,
  };

  it("pasted content becomes an unsaved draft and its warnings are listed", async () => {
    const calls = stubApi({
      ...base,
      "POST /api/infer": () => ({ schemaText: "tables:\n  people: {}\n", tables: ["people"], warnings: ["skipped nested array x"] }),
    });
    await renderWorkspace();
    await userEvent.click(screen.getByRole("tab", { name: "Import" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paste" }));
    await userEvent.type(screen.getByLabelText("Sample or schema text"), "id,name");
    await userEvent.type(screen.getByLabelText("File name"), "people.csv");
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toBe("tables:\n  people: {}\n"));
    expect(screen.getByText("skipped nested array x")).toBeTruthy();
    expect(screen.getByText("Draft not saved yet: press Save to name it.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.find((c) => c.key === "POST /api/infer")!.body).toMatchObject({ content: "id,name", name: "people.csv" });
  });

  it("offers only the database variable names the server reported and sends the name, never a URL", async () => {
    const calls = stubApi({ ...base, "POST /api/infer": () => ({ schemaText: "tables: {}", tables: [], warnings: [] }) });
    await renderWorkspace();
    await userEvent.click(screen.getByRole("tab", { name: "Import" }));
    await userEvent.click(screen.getByRole("tab", { name: "Database" }));
    const select = (await screen.findByLabelText("Database variable")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["DATABASE_URL"]);
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /api/infer")).toBeTruthy());
    expect(calls.find((c) => c.key === "POST /api/infer")!.body).toEqual({ connectionEnv: "DATABASE_URL" });
  });

  it("explains when no database variable is configured", async () => {
    stubApi({ ...base, "GET /api/config": () => ({ llm: { ok: false, reason: "r" }, dbEnv: [] }) });
    await renderWorkspace();
    await userEvent.click(screen.getByRole("tab", { name: "Import" }));
    await userEvent.click(screen.getByRole("tab", { name: "Database" }));
    expect(screen.getByText(/DATABASE_URL/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Infer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open and shows the error when inference fails", async () => {
    stubApi({ ...base, "POST /api/infer": () => errorResponse(400, "Path is outside the server root") });
    await renderWorkspace();
    await userEvent.click(screen.getByRole("tab", { name: "Import" }));
    await userEvent.type(screen.getByLabelText("Path under the folder"), "../x.csv");
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    expect(await screen.findByText(/outside the server root/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Import" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("export", () => {
  const base = {
    "GET /api/config": () => CONFIG_NO_LLM,
    "GET /api/files": () => ({ files: [] }),
    "POST /api/validate": () => OK,
  };

  it("writes files to the chosen folder and lists them", async () => {
    const calls = stubApi({ ...base, "POST /api/export": () => ({ files: ["out/a.csv"], rows: { a: 2 } }) });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "Export…" }));
    await userEvent.selectOptions(screen.getByLabelText("Format"), "csv");
    await userEvent.click(screen.getByRole("button", { name: "Write files" }));
    expect(await screen.findByText("out/a.csv")).toBeTruthy();
    const body = calls.find((c) => c.key === "POST /api/export")!.body;
    expect(body).toMatchObject({ format: "csv", outputDir: "out", overwrite: false });
    expect(body.zip).toBeUndefined();
  });

  it("passes the overwrite choice and shows a conflict error without closing", async () => {
    stubApi({ ...base, "POST /api/export": () => errorResponse(400, "Refusing to overwrite existing files: out/a.csv") });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "Export…" }));
    await userEvent.click(screen.getByRole("button", { name: "Write files" }));
    expect(await screen.findByText(/Refusing to overwrite/)).toBeTruthy();
    expect(screen.getByLabelText("Overwrite existing files")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("downloads a zip", async () => {
    const calls = stubApi({ ...base, "POST /api/export": () => new Response(new Blob(["zip"])) });
    const created: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (created.push(b), "blob:x"), revokeObjectURL: () => {} }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "Export…" }));
    await userEvent.click(screen.getByRole("button", { name: "Download zip" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.find((c) => c.key === "POST /api/export")!.body).toMatchObject({ zip: true });
    expect(created).toHaveLength(1);
    click.mockRestore();
  });

  it("warns that a schema with LLM columns spends model calls", async () => {
    stubApi({ ...base, "POST /api/validate": () => ({ ...OK, llmColumns: ["a.b"] }) });
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "Export…" }));
    expect(await screen.findByText(/model calls/i)).toBeTruthy();
  });
});

describe("review fixes", () => {
  const files = { "GET /api/config": () => CONFIG_NO_LLM, "GET /api/files": () => ({ files: ["a.yaml", "b.yaml"] }), "POST /api/validate": () => OK };

  it("enables the LLM toggle when the schema's own llm block is usable, even though the environment has no provider", async () => {
    stubApi({ ...files, "POST /api/validate": () => ({ ...OK, llmColumns: ["a.b"], llm: { ok: true, provider: "ollama:llama3" } }) });
    await renderWorkspace();
    const box = (await screen.findByLabelText(/Fill LLM columns/)) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
  });

  it("asks before replacing unsaved edits when opening another file, and keeps them on Cancel", async () => {
    stubApi({ ...files, "GET /api/file": (_b, url) => ({ path: url.searchParams.get("path"), text: `text of ${url.searchParams.get("path")}` }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderWorkspace();
    await userEvent.type(await screen.findByLabelText("schema"), "!");
    await userEvent.click(screen.getByRole("button", { name: "b.yaml" }));
    expect(confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value.endsWith("!")).toBe(true);
    confirm.mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: "b.yaml" }));
    await waitFor(() => expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toBe("text of b.yaml"));
    confirm.mockRestore();
  });

  it("does not ask when there is nothing unsaved", async () => {
    stubApi({ ...files, "GET /api/file": () => ({ path: "a.yaml", text: "saved" }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "a.yaml" }));
    await waitFor(() => expect((screen.getByLabelText("schema") as HTMLTextAreaElement).value).toBe("saved"));
    await userEvent.click(screen.getByRole("button", { name: "b.yaml" }));
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});
