import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { LOCALES, setLocale, useLocale, type Locale } from "../i18n";

const LABEL: Record<Locale, string> = { en: "Language", es: "Idioma", zh: "语言" };

/** The translate button and its menu. Each language is named in itself, so anyone can find their own. */
export default function LanguageMenu() {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = LOCALES.find((l) => l.id === locale)!;

  // Opening focuses the current language; a click elsewhere closes the menu.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const away = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function close() { setOpen(false); button.current?.focus(); }
  function choose(id: Locale) { setLocale(id); close(); }
  function onKeyDown(e: ReactKeyboardEvent) {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items.at(-1)?.focus(); }
  }

  return <div className="language-menu">
    <button ref={button} type="button" className="icon-button" aria-haspopup="menu" aria-expanded={open} aria-label={`${LABEL[locale]}: ${current.label}`} title={LABEL[locale]} onClick={() => setOpen((o) => !o)}>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 4.5h8M6.5 2.5v2M4.5 4.5c.5 3 2.5 5.5 5 6.5M8.5 4.5c-.5 3-2.5 5.5-5 6.5" /><path d="m9.5 17.5 3.5-8 3.5 8M10.8 14.5h4.4" />
      </svg>
    </button>
    {open && <div ref={menu} className="language-list" role="menu" aria-label={LABEL[locale]} onKeyDown={onKeyDown}>
      {LOCALES.map((l) => <button key={l.id} type="button" role="menuitemradio" aria-checked={l.id === locale} lang={l.htmlLang} tabIndex={-1} onClick={() => choose(l.id)}>
        {l.label}{l.id === locale && <span aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}
