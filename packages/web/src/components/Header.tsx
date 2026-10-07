import type { ReactNode } from "react";
import { useLocale, type Locale } from "../i18n";
import LanguageMenu from "./LanguageMenu";
import ThemeToggle from "./ThemeToggle";

export function Logo({ size = 32 }: { size?: number }) {
  return <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor" /><g fill="none" stroke="white" strokeWidth="1.6"><rect x="7" y="7" width="7" height="7" rx="1.5"/><rect x="18" y="18" width="7" height="7" rx="1.5"/><path d="M14 10.5h7.5V18M10.5 14v7.5H18"/></g></svg>;
}

const COPY: Record<Locale, { caption: string; home: string; docs: string }> = {
  en: { caption: "Schema to synthetic data", home: "Mockdata home", docs: "Docs" },
  es: { caption: "Del esquema a datos sintéticos", home: "Inicio de mockdata", docs: "Documentación" },
  zh: { caption: "从 Schema 生成合成数据", home: "mockdata 首页", docs: "文档" },
};

/** Pages without their own `nav` (the workspace and sign-in) get a Docs link next to the theme switch.
 *  `localized` pages (landing, docs) follow the chosen language and show the language menu; the workspace stays English. */
export default function Header({ children, nav, localized = false }: { children: ReactNode; nav?: ReactNode; localized?: boolean }) {
  const locale = useLocale();
  const copy = COPY[localized ? locale : "en"];
  return <header className="site-header">
    <a className="brand" href="/" aria-label={copy.home}>
      <Logo />
      <span>mockdata<span className="brand-caption">{copy.caption}</span></span>
    </a>
    {nav}
    <div className="header-account">{!nav && <a className="header-link" href="/docs">{copy.docs}</a>}{localized && <LanguageMenu />}<ThemeToggle />{children}</div>
  </header>;
}
