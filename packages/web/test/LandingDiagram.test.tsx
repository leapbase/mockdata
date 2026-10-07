// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIAGRAM } from "../src/landing/diagram";
import { stubApi } from "./stub";

// React Flow cannot lay out in jsdom; the real diagram is covered by Diagram.test.ts and the browser.
const rendered = vi.fn();
vi.mock("../src/components/SchemaDiagram", () => ({
  default: (props: { data: unknown; embedded?: boolean }) => { rendered(props); return <div data-testid="diagram" />; },
}));
const { default: Landing } = await import("../src/landing/Landing");

const ME_OFF = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rendered.mockClear();
});

describe("landing diagram", () => {
  it("waits until the section is near the screen, then shows the embedded workspace diagram", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    let notify: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: typeof notify) { notify = cb; }
      observe() {}
      disconnect() { disconnect(); }
    });
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 2, name: "See how your tables connect" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading the diagram…");
    expect(rendered).not.toHaveBeenCalled();
    act(() => notify([{ isIntersecting: true }]));
    expect(await screen.findByTestId("diagram")).toBeTruthy();
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({ data: DIAGRAM, embedded: true }));
    expect(disconnect).toHaveBeenCalled();
  });

  it("stays a placeholder where IntersectionObserver is missing", () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Landing />);
    expect(screen.getByRole("status").textContent).toBe("Loading the diagram…");
    expect(rendered).not.toHaveBeenCalled();
  });
});
