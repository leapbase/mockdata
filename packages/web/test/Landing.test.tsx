// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Landing from "../src/landing/Landing";
import Root from "../src/Root";
import { stubApi } from "./stub";

const ME_OFF = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };
const ME_SIGNED_OUT = { user: null, auth: { accountsEnabled: true, googleConfigured: false, emailEnabled: true } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Landing", () => {
  it("shows every section and sends every call to action to the workspace", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1, name: /realistic, related test data/i })).toBeTruthy();
    for (const name of [/three steps/i, /more than random rows/i, /three ways in/i, /where it fits/i, /questions, answered/i]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    const ctas = await screen.findAllByRole("link", { name: "Open workspace" });
    expect(ctas.length).toBeGreaterThanOrEqual(3);
    for (const link of ctas) expect(link.getAttribute("href")).toBe("/app");
    expect(screen.getByRole("link", { name: "Mockdata home" }).getAttribute("href")).toBe("/");
  });

  it("asks a signed-out visitor to sign in when accounts are on", async () => {
    stubApi({ "GET /api/auth/me": () => ME_SIGNED_OUT });
    render(<Landing />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/app");
    expect(screen.getAllByRole("link", { name: "Get started" }).length).toBeGreaterThan(0);
  });

  it("still links to the workspace when the server cannot say who is signed in", async () => {
    stubApi({});
    render(<Landing />);
    expect(screen.getAllByRole("link", { name: "Open workspace" })[0]!.getAttribute("href")).toBe("/app");
  });

  it("switches the example snippets with tabs and arrow keys", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    const user = userEvent.setup();
    render(<Landing />);
    const tabs = within(screen.getByRole("tablist", { name: "Examples" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("primaryKey: true");
    await user.click(tabs.getByRole("tab", { name: "CLI" }));
    expect(screen.getByRole("tabpanel").textContent).toContain("npx mockdata generate");
    await user.keyboard("{ArrowRight}");
    expect(tabs.getByRole("tab", { name: "MCP" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("claude mcp add");
  });

  it("answers questions in expandable FAQ items", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Landing />);
    const faq = screen.getByRole("heading", { name: /questions, answered/i }).closest("section")!;
    expect(faq.querySelectorAll("details").length).toBeGreaterThanOrEqual(5);
    expect(within(faq).getByText(/does infer read my database rows/i)).toBeTruthy();
  });
});

describe("Root", () => {
  const at = (pathname: string, hash = "") => ({ pathname, hash, replace: vi.fn() });

  it("renders the landing page at /", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Root location={at("/")} />);
    expect(await screen.findByRole("heading", { level: 1, name: /realistic, related test data/i })).toBeTruthy();
  });

  it("renders the workspace behind the sign-in gate at /app", async () => {
    stubApi({ "GET /api/auth/me": () => ME_SIGNED_OUT });
    render(<Root location={at("/app")} />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: /realistic/i })).toBeNull();
  });

  it("forwards account links sent before the move to /app", () => {
    stubApi({});
    for (const hash of ["#reset_token=abc", "#verify_token=xyz"]) {
      const loc = at("/", hash);
      const { container } = render(<Root location={loc} />);
      expect(loc.replace).toHaveBeenCalledWith(`/app${hash}`);
      expect(container.textContent).toBe("");
      cleanup();
    }
  });
});
