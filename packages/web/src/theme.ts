import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "mockdata-theme";
const EVENT = "mockdata-theme";

/** The saved choice; storage can be missing or blocked (private windows), which means "system". */
export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Puts the choice on <html data-theme>, where the CSS tokens pick it up. "system" removes it. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Not remembered, but still applied for this page.
  }
  applyTheme(choice);
  window.dispatchEvent(new Event(EVENT));
}

function systemDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return systemDark() ? "dark" : "light";
}

/** The theme actually showing, for widgets that cannot read CSS variables (CodeMirror, React Flow). */
export function useResolvedTheme(): Theme {
  const [theme, setResolved] = useState<Theme>(resolveTheme);
  useEffect(() => {
    const update = () => setResolved(resolveTheme());
    window.addEventListener(EVENT, update);
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
    media?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener(EVENT, update);
      media?.removeEventListener?.("change", update);
    };
  }, []);
  return theme;
}
