import { useState, type ReactNode } from "react";
import { setTheme, storedTheme, type ThemeChoice } from "../theme";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

const ICONS: Record<ThemeChoice, ReactNode> = {
  system: <><rect x="3" y="4" width="14" height="10" rx="1.5" /><path d="M7 17h6" /></>,
  light: <><circle cx="10" cy="10" r="3.5" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" /></>,
  dark: <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" />,
};

/** Cycles System, Light, Dark. The label names the current choice; clicking moves to the next. */
export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  return (
    <button
      type="button"
      className="theme-toggle icon-button"
      aria-label={`Theme: ${LABEL[choice]}`}
      title={`Theme: ${LABEL[choice]} (click for ${LABEL[NEXT[choice]]})`}
      onClick={() => {
        const next = NEXT[choice];
        setTheme(next);
        setChoice(next);
      }}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[choice]}</svg>
    </button>
  );
}
