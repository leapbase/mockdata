// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { errorResponse, stubApi } from "./stub";

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
