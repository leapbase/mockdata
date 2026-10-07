// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES, detectLocale, setLocale, storedLocale, type Locale } from "../src/i18n";
import Docs, { searchDocs } from "../src/docs/Docs";
import { PAGES } from "../src/docs/content";
import { DOCS_STRINGS } from "../src/docs/strings";
import { applyDictionary, loadDictionary, sourceStrings, type Dictionary } from "../src/docs/translate";
import es from "../src/docs/i18n/es";
import zh from "../src/docs/i18n/zh";
import Landing from "../src/landing/Landing";
import { LANDING_COPY, type LandingCopy } from "../src/landing/copy";
import AuthGate from "../src/AuthGate";
import { stubApi } from "./stub";

const ME_OFF = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };
const DICTS: Record<Exclude<Locale, "en">, Dictionary> = { es, zh };
const at = (pathname: string) => ({ pathname, hash: "", replace: vi.fn() });

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.lang = "en";
});

/** What a translation must keep from its English source: `code` spans, link targets and numbers. */
function marks(text: string) {
  const code = (text.match(/`[^`]*`/g) ?? []).sort();
  const links = [...text.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]).sort();
  const plain = text.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]").replace(/(\d)[,.](?=\d{3}\b)/g, "$1");
  return { code, links, numbers: (plain.match(/\d+/g) ?? []).sort() };
}

describe("locale", () => {
  it("follows the browser's first supported language, by primary subtag", () => {
    expect(detectLocale(["es-MX", "en"])).toBe("es");
    expect(detectLocale(["zh-TW"])).toBe("zh");
    expect(detectLocale(["fr-FR", "zh-CN"])).toBe("zh");
    expect(detectLocale(["fr-FR"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
  it("remembers a choice and marks the page language", () => {
    setLocale("zh");
    expect(storedLocale()).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    setLocale("es");
    expect(document.documentElement.lang).toBe("es");
  });
  it("still works when storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, clear: () => undefined });
    expect(() => setLocale("es")).not.toThrow();
    expect(LOCALES.map((l) => l.id)).toContain(storedLocale());
  });
});

describe("docs translations", () => {
  const source = sourceStrings(PAGES);
  for (const [locale, dict] of Object.entries(DICTS)) {
    it(`${locale}: translates every English string and nothing that no longer exists`, () => {
      expect(source.filter((s) => !(s in dict)), "untranslated").toEqual([]);
      expect(Object.keys(dict).filter((k) => !source.includes(k)), "stale").toEqual([]);
    });
    it(`${locale}: keeps code, links and numbers exactly`, () => {
      for (const [en, text] of Object.entries(dict)) expect(marks(text), `${en}\n=> ${text}`).toEqual(marks(en));
    });
  }
  it("keeps slugs, section ids, links and code blocks when applied", () => {
    const zhPages = applyDictionary(PAGES, zh);
    expect(zhPages.map((p) => p.slug)).toEqual(PAGES.map((p) => p.slug));
    expect(zhPages.flatMap((p) => p.sections.map((s) => s.id))).toEqual(PAGES.flatMap((p) => p.sections.map((s) => s.id)));
    const codes = (pages: typeof PAGES) => pages.flatMap((p) => p.sections.flatMap((s) => s.blocks.flatMap((b) => ("code" in b ? [b.code] : []))));
    expect(codes(zhPages)).toEqual(codes(PAGES));
    expect(zhPages[0]!.title).toBe("mockdata 文档");
  });
  it("searches in the reader's language", () => {
    const zhPages = applyDictionary(PAGES, zh);
    expect(searchDocs("外键", 8, zhPages).length).toBeGreaterThan(0);
    expect(searchDocs("claves foráneas", 8, applyDictionary(PAGES, es))[0]!.href).toMatch(/^\/docs\/relationships/);
  });
  it("loads a dictionary only for a translated language", async () => {
    expect(await loadDictionary("en")).toBeNull();
    expect(await loadDictionary("es")).toBe(es);
  });
  it("has the same labels in every language", () => {
    for (const locale of ["es", "zh"] as const) expect(Object.keys(DOCS_STRINGS[locale]).sort()).toEqual([...Object.keys(DOCS_STRINGS.en), "translated"].sort());
  });
});

describe("landing translations", () => {
  /** The same shape in every language: same keys and the same number of steps, features, use cases and questions. */
  function shape(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(shape);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
    return typeof v;
  }
  it("says the same things in every language", () => {
    for (const locale of ["es", "zh"] as const) {
      expect(shape(LANDING_COPY[locale])).toEqual(shape(LANDING_COPY.en));
      const urls = (c: LandingCopy) => JSON.stringify(c).match(/https:\/\/[A-Za-z0-9./_-]+/g)?.sort();
      expect(urls(LANDING_COPY[locale])).toEqual(urls(LANDING_COPY.en));
    }
  });
});

describe("language menu", () => {
  it("switches the landing page in place and is remembered", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Landing />);
    expect(screen.getByRole("heading", { level: 1, name: /realistic, related test data/i })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Language: English" }));
    const menu = screen.getByRole("menu", { name: "Language" });
    expect(within(menu).getByRole("menuitemradio", { name: "English" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitemradio", { name: "English" }));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: /datos de prueba realistas/i })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Idioma: Español" }));
    expect(localStorage.getItem("mockdata-lang")).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });

  it("closes on Escape without changing the language", async () => {
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<Landing />);
    await userEvent.click(screen.getByRole("button", { name: "Language: English" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(storedLocale()).toBe("en");
  });

  it("translates the docs, including the page text once its dictionary loads", async () => {
    setLocale("zh");
    render(<Docs location={at("/docs/relationships")} />);
    expect(screen.getByRole("navigation", { name: "文档页面" })).toBeTruthy();
    expect(await screen.findByRole("heading", { level: 1, name: "关系" })).toBeTruthy();
    expect(screen.getByText(/本页译自英文原文/)).toBeTruthy();
    expect(document.title).toBe("关系 · mockdata 文档");
    await act(async () => setLocale("en"));
    expect(await screen.findByRole("heading", { level: 1, name: "Relationships" })).toBeTruthy();
    expect(screen.queryByText(/本页译自英文原文/)).toBeNull();
  });

  it("is not offered in the workspace, which stays English", async () => {
    setLocale("es");
    stubApi({ "GET /api/auth/me": () => ME_OFF });
    render(<AuthGate><p>workspace</p></AuthGate>);
    expect(await screen.findByText("workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /idioma|language/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Docs" })).toBeTruthy();
  });
});
