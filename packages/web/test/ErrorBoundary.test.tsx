// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../src/components/ErrorBoundary";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Broken(): never { throw new Error("secret schema text"); }

describe("ErrorBoundary", () => {
  it("shows a way back instead of a blank page, without the error's text", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload the page" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the home page" }).getAttribute("href")).toBe("/");
    expect(document.body.textContent).not.toContain("secret schema text");
    expect(logged).toHaveBeenCalled();
  });
  it("renders its children when nothing fails", () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });
});
