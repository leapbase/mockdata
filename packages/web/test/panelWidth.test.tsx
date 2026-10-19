// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { PANEL_DEFAULT, PANEL_MIN, clampWidth } from "../src/panelWidth";
import { stubApi } from "./stub";

vi.mock("../src/components/Editor", () => ({ default: ({ value, onChange }: any) =>
  <textarea aria-label="schema" value={value} onChange={(e) => onChange(e.target.value)} /> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const setup = () => stubApi({ "GET /api/files": () => ({ files: [] }), "GET /api/config": () => ({ llm: { ok: false, reason: "none" }, dbEnv: [] }), "POST /api/validate": () => ({ ok: false, errors: [] }) });

/** jsdom lays nothing out: give the panel and the editor real edges so the limit can be computed (1440 px window, 280 px sidebar). */
function layOut(editorLeft = 280, panelRight = 1440) {
  const rect = (left: number, right: number) => ({ left, right, width: right - left, top: 0, bottom: 900, height: 900, x: left, y: 0, toJSON() {} }) as DOMRect;
  (document.querySelector("main.editor") as HTMLElement).getBoundingClientRect = () => rect(editorLeft, panelRight - 420);
  (document.querySelector("#generation-panel") as HTMLElement).getBoundingClientRect = () => rect(panelRight - 420, panelRight);
}

describe("clampWidth", () => {
  it("keeps a width between the minimum and the room there is", () => {
    expect(clampWidth(500, 800)).toBe(500);
    expect(clampWidth(100, 800)).toBe(PANEL_MIN);
    expect(clampWidth(2000, 800)).toBe(800);
    expect(clampWidth(500, 100)).toBe(PANEL_MIN); // a window too narrow for both: the panel keeps its minimum
  });
});

describe("the generation panel's width", () => {
  it("says what the header button does, and sizes the name field to the name so Save sits beside it", async () => {
    setup();
    render(<App debounceMs={0} />);
    const opener = screen.getByRole("button", { name: "Generate data" });
    expect(opener.textContent).toContain("Generate data"); // visible words, not only an arrow
    const name = screen.getByLabelText("Schema name") as HTMLInputElement;
    expect(name.size).toBe("Untitled schema".length);
    await userEvent.type(name, "orders");
    expect(name.size).toBe(8); // a short name still leaves room to click into
  });

  it("is resized with the keyboard from the panel's edge, never below the minimum or past the editor's room, and remembered", async () => {
    setup();
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    layOut();
    const edge = screen.getByRole("separator", { name: "Resize generation panel" });
    const panel = document.querySelector("#generation-panel") as HTMLElement;
    expect(edge.getAttribute("aria-valuenow")).toBe(String(PANEL_DEFAULT));
    expect(panel.style.width).toBe(`${PANEL_DEFAULT}px`);
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(panel.style.width).toBe(`${PANEL_DEFAULT + 24}px`);
    expect(localStorage.getItem("mockdata-generation-width")).toBe(String(PANEL_DEFAULT + 24));
    fireEvent.keyDown(edge, { key: "End" }); // as wide as allowed: 1440 - 280 - 360
    expect(panel.style.width).toBe("800px");
    fireEvent.keyDown(edge, { key: "Home" });
    expect(panel.style.width).toBe(`${PANEL_MIN}px`);
    fireEvent.keyDown(edge, { key: "ArrowRight" });
    expect(panel.style.width).toBe(`${PANEL_MIN}px`);
    fireEvent.keyDown(edge, { key: "Enter" }); // back to the default, which is not stored
    expect(panel.style.width).toBe(`${PANEL_DEFAULT}px`);
    expect(localStorage.getItem("mockdata-generation-width")).toBeNull();
  });

  it("is dragged from its left edge: moving left widens it, and a double-click resets it", async () => {
    setup();
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    layOut();
    const edge = screen.getByRole("separator", { name: "Resize generation panel" });
    const panel = document.querySelector("#generation-panel") as HTMLElement;
    fireEvent.pointerDown(edge, { button: 0, clientX: 1020, pointerId: 1 });
    expect(panel.className).toContain("resizing");
    fireEvent.pointerMove(edge, { clientX: 900, pointerId: 1 });
    expect(panel.style.width).toBe(`${PANEL_DEFAULT + 120}px`);
    fireEvent.pointerUp(edge, { clientX: 880, pointerId: 1 });
    expect(panel.style.width).toBe(`${PANEL_DEFAULT + 140}px`);
    expect(panel.className).not.toContain("resizing");
    expect(localStorage.getItem("mockdata-generation-width")).toBe(String(PANEL_DEFAULT + 140));
    fireEvent.doubleClick(edge);
    expect(panel.style.width).toBe(`${PANEL_DEFAULT}px`);
  });

  it("starts at the remembered width", async () => {
    localStorage.setItem("mockdata-generation-width", "560");
    setup();
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    expect((document.querySelector("#generation-panel") as HTMLElement).style.width).toBe("560px");
  });

  it("is a full-height drawer on a narrow window, with no resize edge", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    setup();
    render(<App debounceMs={0} />);
    await userEvent.click(screen.getByRole("button", { name: "Generate data" }));
    expect(screen.queryByRole("separator")).toBeNull();
    expect((document.querySelector("#generation-panel") as HTMLElement).style.width).toBe("");
  });
});
