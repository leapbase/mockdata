// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Landing from "../src/landing/Landing";
import Root from "../src/Root";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LLM_SNIPPET, MCP_TOOLS } from "../src/landing/content";
import { stubApi } from "./stub";

const ME_OFF = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };

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

  it("by default goes straight to the workspace and never asks the server who is signed in", async () => {
    const calls = stubApi({});
    render(<Landing />);
    expect(screen.getAllByRole("link", { name: "Open workspace" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("lets a hosted shell relabel the calls to action through the useLandingCta slot", () => {
    stubApi({});
    render(<Landing useCta={(t, locale) => ({ primary: `${t.cta.openWorkspace} (${locale})`, nav: "Sign in" })} />);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/app");
    expect(screen.getAllByRole("link", { name: "Open workspace (en)" }).length).toBeGreaterThan(0);
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
    expect(screen.getByRole("tabpanel").textContent).toContain("claude mcp add mockdata -e MOCKDATA_ROOT=/path/to/folder -- node /path/to/mockdata/packages/mcp/dist/bin.js");
    for (const tool of MCP_TOOLS) expect(panel.getByText(tool)).toBeTruthy();
    expect(panel.getByRole("link", { name: /LLM-written text/ }).getAttribute("href")).toBe("/docs/llm");
    expect(panel.getByRole("link", { name: /MCP in your editor/ }).getAttribute("href")).toBe("/docs/mcp-local");
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

  it("opens the workspace at / in the open build, with a link to the source", async () => {
    stubApi({});
    render(<Root location={at("/")} />);
    expect(await screen.findByText("Local workspace")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: /realistic/i })).toBeNull();
    expect(screen.getByRole("link", { name: /Source/ }).getAttribute("href")).toBe("https://github.com/leapbase/mockdata");
  });

  it("renders the landing page at / when a hosted shell asks for it", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Root landing location={at("/")} />);
    expect(await screen.findByRole("heading", { level: 1, name: /realistic, related test data/i })).toBeTruthy();
  });

  it("renders the workspace behind the gate a hosted shell supplies at /app", async () => {
    stubApi({});
    const Gate = ({ children }: { children: ReactNode }) => <div><button>Sign in</button>{children}</div>;
    render(<Root gate={Gate} location={at("/app")} />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: /realistic/i })).toBeNull();
  });

  it("forwards account links sent before the move to /app", () => {
    stubApi({});
    for (const hash of ["#reset_token=abc", "#verify_token=xyz"]) {
      const loc = at("/", hash);
      const { container } = render(<Root landing location={loc} />);
      expect(loc.replace).toHaveBeenCalledWith(`/app${hash}`);
      expect(container.textContent).toBe("");
      cleanup();
    }
  });
});

describe("Landing: what the AI tab promises matches the docs", () => {
  it("shows the same local MCP command, and links to the page that documents it", async () => {
    const { PAGES } = await import("../src/docs/content");
    const { LANDING_COPY } = await import("../src/landing/copy");
    const local = PAGES.find((p) => p.slug === "mcp-local")!;
    const codes = local.sections.flatMap((s) => s.blocks).flatMap((b) => ("code" in b ? [b.code] : []));
    for (const locale of ["en", "es", "zh"] as const) {
      expect(codes).toContain(LANDING_COPY[locale].ai.mcpCommand);
      expect(LANDING_COPY[locale].ai.mcpHref).toBe("/docs/mcp-local");
    }
  });
});
