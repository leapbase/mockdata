import { useEffect, useState } from "react";

/** Languages of the public pages (landing and docs). The workspace is English only for now. */
export type Locale = "en" | "es" | "zh";
export const LOCALES: readonly { id: Locale; label: string; htmlLang: string }[] = [
  { id: "en", label: "English", htmlLang: "en" },
  { id: "es", label: "Español", htmlLang: "es" },
  { id: "zh", label: "中文", htmlLang: "zh-CN" },
];

const KEY = "mockdata-lang";
const EVENT = "mockdata-lang";
const isLocale = (v: unknown): v is Locale => LOCALES.some((l) => l.id === v);

/** The browser's first preferred language we have, by its primary subtag (es-MX -> es, zh-TW -> zh), else English. */
export function detectLocale(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): Locale {
  for (const tag of languages) {
    const primary = tag?.toLowerCase().split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return "en";
}

/** The saved choice, else the browser's language. Storage can be missing or blocked (private windows). */
export function storedLocale(): Locale {
  try {
    const v = localStorage.getItem(KEY);
    if (isLocale(v)) return v;
  } catch {
    // fall through to detection
  }
  return detectLocale();
}

export function applyLocale(locale: Locale): void {
  document.documentElement.lang = LOCALES.find((l) => l.id === locale)!.htmlLang;
}

export function setLocale(locale: Locale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // Not remembered, but still applied for this page.
  }
  applyLocale(locale);
  window.dispatchEvent(new Event(EVENT));
}

/** The current language; every component using it re-renders when the language menu changes it. */
export function useLocale(): Locale {
  const [locale, setCurrent] = useState<Locale>(storedLocale);
  useEffect(() => {
    applyLocale(locale);
    const update = () => setCurrent(storedLocale());
    window.addEventListener(EVENT, update);
    return () => window.removeEventListener(EVENT, update);
  }, [locale]);
  return locale;
}
