// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Docs, { searchDocs, slugFromPath } from "../src/docs/Docs";
import { PAGES, pageHref, type Block } from "../src/docs/content";
import Root, { isDocsPath } from "../src/Root";
import { isDocsPath as serverIsDocsPath } from "../../server/src/static";
import { stubApi } from "./stub";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const at = (pathname: string, hash = "") => ({ pathname, hash, replace: vi.fn() });

/** Every href in the copy: [text](href) links and cards. */
function hrefs(block: Block): string[] {
  const texts = "p" in block ? [block.p] : "list" in block ? block.list : "note" in block ? [block.note] : "table" in block ? block.table.rows.flat() : [];
  const links = texts.flatMap((t) => [...t.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!));
  return "cards" in block ? [...links, ...block.cards.map((c) => c.href)] : links;
}

describe("docs content", () => {
  it("has unique slugs and unique section ids on each page", () => {
    expect(new Set(PAGES.map((p) => p.slug)).size).toBe(PAGES.length);
    expect(PAGES[0]!.slug).toBe("");
    for (const p of PAGES) {
      expect(p.slug, p.title).toMatch(/^([a-z0-9-]+)?$/);
      expect(new Set(p.sections.map((s) => s.id)).size, p.title).toBe(p.sections.length);
    }
  });

  it("only links to pages and sections that exist", () => {
    for (const p of PAGES) for (const s of p.sections) for (const b of s.blocks) for (const href of hrefs(b)) {
      if (!href.startsWith("/docs")) { expect(href, `${p.title} › ${s.title}`).toMatch(/^(\/app|\/|https:\/\/)/); continue; }
      const [path, hash] = href.split("#");
      const target = PAGES.find((q) => pageHref(q.slug) === path);
      expect(target, `${p.title} › ${s.title}: ${href}`).toBeDefined();
      if (hash) expect(target!.sections.some((x) => x.id === hash), `${p.title} › ${s.title}: ${href}`).toBe(true);
    }
  });

  it("is served by the server for exactly the paths the page answers", () => {
    for (const p of ["/docs", "/docs/", "/docs/schema", "/docs/quick-start/", "/docs/missing-page"]) {
      expect(isDocsPath(p), p).toBe(true);
      expect(serverIsDocsPath(p), p).toBe(true);
    }
    for (const p of ["/docs/a/b", "/docs/x.js", "/docs/Schema", "/docsx", "/doc"]) {
      expect(isDocsPath(p), p).toBe(false);
      expect(serverIsDocsPath(p), p).toBe(false);
    }
    expect(slugFromPath("/docs/schema/")).toBe("schema");
    expect(slugFromPath("/docs")).toBe("");
  });
});

describe("docs search", () => {
  it("finds sections by option name and ranks title matches first", () => {
    const hits = searchDocs("maxPerParent");
    expect(hits.some((h) => h.href === "/docs/relationships#one-to-one-and-caps")).toBe(true);
    expect(searchDocs("self references")[0]!.href).toBe("/docs/relationships#self-references");
    expect(searchDocs("api key mcp")[0]!.href).toMatch(/^\/docs\/mcp(#|$)/);
    expect(searchDocs("connectionEnv").map((h) => h.href)).toContain("/docs/mcp-local#databases");
  });
  it("needs every word and returns nothing for an empty query", () => {
    expect(searchDocs("")).toEqual([]);
    expect(searchDocs("zipf nonexistentword")).toEqual([]);
  });
});

describe("Docs page", () => {
  it("renders the overview with the full sidebar, the outline and a next link", () => {
    render(<Docs location={at("/docs")} />);
    expect(screen.getByRole("heading", { level: 1, name: "mockdata documentation" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Documentation pages" });
    expect(within(nav).getAllByRole("link")).toHaveLength(PAGES.length);
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    const toc = screen.getByRole("navigation", { name: "On this page" });
    expect(within(toc).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(PAGES[0]!.sections.map((s) => `#${s.id}`));
    expect(screen.getByRole("link", { name: /next quick start/i }).getAttribute("href")).toBe("/docs/quick-start");
    expect(screen.getByRole("link", { name: "Open workspace" }).getAttribute("href")).toBe("/app");
  });

  it("changes page in place from the sidebar and keeps the address in step", async () => {
    window.history.replaceState(null, "", "/docs");
    render(<Docs location={at("/docs")} />);
    await userEvent.click(screen.getByRole("link", { name: "Relationships" }));
    expect(screen.getByRole("heading", { level: 1, name: "Relationships" })).toBeTruthy();
    expect(window.location.pathname).toBe("/docs/relationships");
    expect(document.title).toBe("Relationships · mockdata docs");
    expect(screen.getByRole("link", { name: /previous schema format/i })).toBeTruthy();
  });

  it("searches with the keyboard and opens the chosen section", async () => {
    window.history.replaceState(null, "", "/docs");
    render(<Docs location={at("/docs")} />);
    await userEvent.keyboard("/");
    const box = screen.getByRole("combobox", { name: "Search docs" });
    expect(document.activeElement).toBe(box);
    await userEvent.type(box, "within");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("heading", { level: 1, name: "Values and rules" })).toBeTruthy();
    expect(window.location.hash).toBe("#date-rules");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says when a page does not exist", () => {
    render(<Docs location={at("/docs/nope")} />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the documentation home" }).getAttribute("href")).toBe("/docs");
  });

  it("is what Root renders under /docs", async () => {
    stubApi({});
    render(<Root location={at("/docs/cli")} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Command line" })).toBeTruthy();
  });
});
