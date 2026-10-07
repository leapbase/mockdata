import type { Locale } from "../i18n";
import type { Block, DocPage } from "./content";

/** English text -> translated text. A string with no entry stays English, so a page never breaks for a missing line. */
export type Dictionary = Record<string, string>;

/** Strings that need a translator: anything with words left once `code` spans and link targets are removed. */
export const needsTranslation = (text: string) => /\p{L}{2,}/u.test(text.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "]"));

function mapBlock(b: Block, t: (s: string) => string): Block {
  if ("p" in b) return { p: t(b.p) };
  if ("code" in b) return b; // code, and its file-name title, is the same in every language
  if ("table" in b) return { table: { head: b.table.head.map(t), rows: b.table.rows.map((r) => r.map(t)) } };
  if ("list" in b) return { ...b, list: b.list.map(t) };
  if ("note" in b) return { ...b, note: t(b.note), ...(b.title ? { title: t(b.title) } : {}) };
  return { cards: b.cards.map((c) => ({ ...c, title: t(c.title), body: t(c.body) })) };
}

/** Every translatable string of the pages, in reading order. Slugs, ids, icons, hrefs and code are left alone. */
export function translatePages(pages: DocPage[], t: (s: string) => string): DocPage[] {
  return pages.map((p) => ({
    ...p, title: t(p.title), group: t(p.group), summary: t(p.summary),
    sections: p.sections.map((s) => ({ ...s, title: t(s.title), blocks: s.blocks.map((b) => mapBlock(b, t)) })),
  }));
}

/** The English strings a dictionary should cover. */
export function sourceStrings(pages: DocPage[]): string[] {
  const out = new Set<string>();
  translatePages(pages, (s) => { if (needsTranslation(s)) out.add(s); return s; });
  return [...out];
}

export const applyDictionary = (pages: DocPage[], dict: Dictionary) => translatePages(pages, (s) => dict[s] ?? s);

/** The dictionaries are separate chunks, fetched only when someone picks that language. */
export function loadDictionary(locale: Locale): Promise<Dictionary | null> {
  if (locale === "es") return import("./i18n/es").then((m) => m.default);
  if (locale === "zh") return import("./i18n/zh").then((m) => m.default);
  return Promise.resolve(null);
}
