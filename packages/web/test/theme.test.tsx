// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ThemeToggle from "../src/components/ThemeToggle";
import { applyTheme, setTheme, storedTheme, useResolvedTheme } from "../src/theme";

let systemDark = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  systemDark = false;
  listeners.clear();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("dark") && systemDark;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  return <span data-testid="theme">{useResolvedTheme()}</span>;
}

describe("theme", () => {
  it("follows the system until a choice is made, and remembers the choice", () => {
    render(<Probe />);
    expect(screen.getByTestId("theme").textContent).toBe("light");
    act(() => {
      systemDark = true;
      listeners.forEach((fn) => fn());
    });
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    act(() => setTheme("light"));
    expect(screen.getByTestId("theme").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(storedTheme()).toBe("light");
    act(() => setTheme("system"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedTheme()).toBe("system");
  });

  it("treats blocked storage as system", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(storedTheme()).toBe("system");
    applyTheme(storedTheme());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    vi.restoreAllMocks();
  });

  it("cycles system, light and dark from the header toggle", async () => {
    const user = userEvent.setup();
    render(<><ThemeToggle /><Probe /></>);
    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    expect(screen.getByTestId("theme").textContent).toBe("light");
    await user.click(screen.getByRole("button", { name: "Theme: Light" }));
    expect(screen.getByTestId("theme").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await user.click(screen.getByRole("button", { name: "Theme: Dark" }));
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeTruthy();
    expect(localStorage.getItem("mockdata-theme")).toBeNull();
  });
});
