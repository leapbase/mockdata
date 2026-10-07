// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Landing from "../src/landing/Landing";
import Root from "../src/Root";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLM_SNIPPET, MCP_TOOLS } from "../src/landing/content";
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

  it("links to the source code and the license (AGPL-3.0 section 13 for the hosted site)", () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Landing />);
    expect(screen.getByRole("link", { name: "Source on GitHub" }).getAttribute("href")).toBe("https://github.com/leapbase/mockdata");
    expect(screen.getByRole("link", { name: "AGPL-3.0" }).getAttribute("href")).toMatch(/\/LICENSE$/);
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
    await user.keyboard("{ArrowLeft}");
    expect(tabs.getByRole("tab", { name: "AI" }).getAttribute("aria-selected")).toBe("true");
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByRole("heading", { name: "Columns a model writes" })).toBeTruthy();
    expect(panel.getByText(/llm: \{ prompt: "A one or two sentence customer review/)).toBeTruthy();
    expect(panel.getByRole("heading", { name: "Agents over MCP" })).toBeTruthy();
    expect(screen.getByRole("tabpanel").textContent).toContain("claude mcp add --transport http mockdata https://mockdata.com/mcp");
    for (const tool of MCP_TOOLS) expect(panel.getByText(tool)).toBeTruthy();
    expect(panel.getByRole("link", { name: /LLM-written text/ }).getAttribute("href")).toBe("/docs/llm");
    expect(panel.getByRole("link", { name: /MCP on the web/ }).getAttribute("href")).toBe("/docs/mcp");
  });

  it("opens the AI tab from the AI link in the header", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Landing />);
    await userEvent.click(within(screen.getByRole("navigation", { name: "Page sections" })).getByRole("link", { name: "AI" }));
    expect(screen.getByRole("tab", { name: "AI" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows a real prompt and the MCP server's real tools", () => {
    expect(readFileSync(resolve("examples/shop-llm.yaml"), "utf8")).toContain(LLM_SNIPPET);
    const server = readFileSync(resolve("packages/mcp/src/server.ts"), "utf8");
    const registered = [...server.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(0);
    expect([...MCP_TOOLS].sort()).toEqual([...new Set(registered)].sort());
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
