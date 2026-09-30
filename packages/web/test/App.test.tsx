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

describe("shell", () => {
  it("lists files, opens one into the editor, validates it and shows the summary", async () => {
    stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: ["shop.yaml", "hr.yaml"] }),
      "GET /api/file": (_b, url) => ({ path: url.searchParams.get("path"), text: "tables:\n  a: {}\n" }),
      "POST /api/validate": () => OK,
    });
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
    expect(await screen.findAllByText("bad ref")).toHaveLength(2);
  });

  it("creates a new file: asks for a name, adds .yaml, saves with create:true", async () => {
    const calls = stubApi({
      "GET /api/config": () => CONFIG_NO_LLM,
      "GET /api/files": () => ({ files: [] }),
      "POST /api/validate": () => OK,
      "PUT /api/file": () => ({ path: "fresh.yaml" }),
    });
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
    await userEvent.type(await screen.findByLabelText("Seed"), "42");
    await userEvent.type(screen.getByLabelText("Rows per table"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("tab", { name: /a/ })).toBeTruthy();
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
    render(<App debounceMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: "Generate" }));
    await screen.findByRole("tab", { name: /a/ });
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invalid schema: x");
    expect(screen.getByRole("tab", { name: /a/ })).toBeTruthy();
  });

  it("disables the LLM toggle with the server's reason", async () => {
    stubApi({ "GET /api/config": () => CONFIG_NO_LLM, "GET /api/files": () => ({ files: [] }), "POST /api/validate": () => OK });
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
    // A first, plain run gives us a preview to keep.
    await userEvent.click(await screen.findByRole("button", { name: "Generate" }));
    await screen.findByRole("tab", { name: /a/ });

    const box = screen.getByLabelText(/Fill LLM columns/) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    await userEvent.click(box);
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("status")).textContent).toContain("notes.body: 2 / 5");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(signal!.aborted).toBe(true));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled/i);
    expect(screen.getByRole("tab", { name: /a/ })).toBeTruthy();
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
    render(<App debounceMs={0} />);
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
    render(<App debounceMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /Infer from source/ }));
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
    render(<App debounceMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /Infer from source/ }));
    await userEvent.click(screen.getByRole("tab", { name: "Database" }));
    const select = (await screen.findByLabelText("Database variable")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["DATABASE_URL"]);
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /api/infer")).toBeTruthy());
    expect(calls.find((c) => c.key === "POST /api/infer")!.body).toEqual({ connectionEnv: "DATABASE_URL" });
  });

  it("explains when no database variable is configured", async () => {
    stubApi({ ...base, "GET /api/config": () => ({ llm: { ok: false, reason: "r" }, dbEnv: [] }) });
    render(<App debounceMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /Infer from source/ }));
    await userEvent.click(screen.getByRole("tab", { name: "Database" }));
    expect(screen.getByText(/DATABASE_URL/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Infer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open and shows the error when inference fails", async () => {
    stubApi({ ...base, "POST /api/infer": () => errorResponse(400, "Path is outside the server root") });
    render(<App debounceMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /Infer from source/ }));
    await userEvent.type(screen.getByLabelText("Path under the folder"), "../x.csv");
    await userEvent.click(screen.getByRole("button", { name: "Infer" }));
    expect(await screen.findByText(/outside the server root/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
