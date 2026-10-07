// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGES, pageHref, type Block, type DocPage } from "../../src/docs/content";
import { searchDocs } from "../../src/docs/Docs";
import { applyDictionary, sourceStrings } from "../../src/docs/translate";
import { useAccountCta } from "../../src/hosted/AuthGate";
import { HOSTED_DOCS, SWAPS } from "../../src/hosted/docs";
import es from "../../src/hosted/i18n/es";
import zh from "../../src/hosted/i18n/zh";
import { MCP_COMMAND, MCP_URL, hostedLandingCopy } from "../../src/hosted/landing";
import Landing from "../../src/landing/Landing";
import { LANDING_COPY } from "../../src/landing/copy";
import { stubApi } from "../stub";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hosted = HOSTED_DOCS.pages!(PAGES);
const strings = (pages: DocPage[]) => {
  const out = new Set<string>();
  applyDictionary(pages, new Proxy({}, { get: (_t, k) => (out.add(String(k)), undefined) }));
  return out;
};
const links = (pages: DocPage[]) =>
  pages.flatMap((p) => p.sections.flatMap((s) => s.blocks.flatMap((b: Block) => JSON.stringify(b).match(/\]\((\/docs[^)\\"]*)\)|"href":"(\/docs[^"]*)"/g) ?? []).map((m) => m.replace(/^\]\(|\)$|^"href":"|"$/g, ""))));

describe("hosted docs (added to the open docs through the docs slot)", () => {
  it("adds the MCP and Accounts pages, and every wording swap still matches the open text", () => {
    expect(hosted.map((p) => p.slug)).toEqual(expect.arrayContaining(["mcp", "accounts"]));
    expect(PAGES.map((p) => p.slug)).not.toEqual(expect.arrayContaining(["mcp"]));
    const open = strings(PAGES), withHosted = strings(hosted);
    for (const [from, to] of SWAPS) {
      expect(open.has(from), from.slice(0, 50)).toBe(true);
      expect(withHosted.has(to), to.slice(0, 50)).toBe(true);
      expect(withHosted.has(from), `swapped away: ${from.slice(0, 50)}`).toBe(false);
    }
  });

  it("puts the hosted pages beside the local ones and keeps slugs and section ids unique", () => {
    const slugs = hosted.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.indexOf("mcp")).toBe(slugs.indexOf("mcp-local") - 1);
    for (const p of hosted) expect(new Set(p.sections.map((s) => s.id)).size).toBe(p.sections.length);
  });

  it("links only to pages and sections that exist", () => {
    for (const link of links(hosted)) {
      const [path, hash] = link.split("#");
      const page = hosted.find((p) => pageHref(p.slug) === path);
      expect(page, link).toBeTruthy();
      if (hash) expect(page!.sections.some((s) => s.id === hash), link).toBe(true);
    }
  });

  it("is found by search", () => {
    expect(searchDocs("api key mcp", 8, hosted)[0]!.href).toMatch(/^\/docs\/mcp(#|$)/);
  });

  it.each([["es", es], ["zh", zh]] as const)("has a %s translation for exactly the strings it adds", (_loc, dict) => {
    const open = new Set(sourceStrings(PAGES));
    const added = sourceStrings(hosted).filter((s) => !open.has(s));
    expect(added.filter((s) => !(s in dict))).toEqual([]); // untranslated
    expect(Object.keys(dict).filter((k) => !added.includes(k))).toEqual([]); // stale
  });
});

describe("hosted landing copy", () => {
  it.each(["en", "es", "zh"] as const)("keeps the shape of the open copy (%s) and says what mockdata.com offers", (locale) => {
    const base = LANDING_COPY[locale];
    const copy = hostedLandingCopy(base, locale);
    const shape = (v: unknown): unknown => (Array.isArray(v) ? v.map(shape) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
    expect(shape(copy)).toEqual(shape(base));
    expect(copy.ai.mcpCommand).toBe(MCP_COMMAND);
    expect(copy.ai.mcpHref).toBe("/docs/mcp");
    expect(JSON.stringify(copy.features.items[5])).toContain(MCP_URL);
    expect(JSON.stringify(copy.faq.items[4])).toContain(MCP_URL);
    expect(JSON.stringify(base)).not.toContain(MCP_URL); // the open copy never names mockdata.com's endpoint
  });

  it("renders in the AI tab with the hosted command and link", async () => {
    stubApi({ "GET /api/auth/me": () => ({ user: null, auth: { accountsEnabled: true, googleConfigured: false, emailEnabled: true } }) });
    render(<Landing copy={hostedLandingCopy} useCta={useAccountCta} />);
    expect((await screen.findByRole("link", { name: "Sign in" })).getAttribute("href")).toBe("/app");
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(within(screen.getByRole("navigation", { name: "Page sections" })).getByRole("link", { name: "AI" }));
    const panel = within(screen.getByRole("tabpanel"));
    expect(panel.getByText(/claude mcp add --transport http mockdata https:\/\/mockdata\.com\/mcp/)).toBeTruthy();
    expect(panel.getByRole("link", { name: /MCP on the web/ }).getAttribute("href")).toBe("/docs/mcp");
  });
});
