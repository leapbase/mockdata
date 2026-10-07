// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LocalGate from "../src/components/LocalGate";
import { stubApi } from "./stub";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LocalGate (the open build's default around the workspace)", () => {
  it("shows the app straight away under a local-workspace header, with no sign-in and no account call", () => {
    stubApi({});
    render(<LocalGate><p>the app</p></LocalGate>);
    expect(screen.getByText("Local workspace")).toBeTruthy();
    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
