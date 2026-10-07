import type { ReactNode } from "react";
import ThemeToggle from "./ThemeToggle";

export function Logo({ size = 32 }: { size?: number }) {
  return <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor" /><g fill="none" stroke="white" strokeWidth="1.6"><rect x="7" y="7" width="7" height="7" rx="1.5"/><rect x="18" y="18" width="7" height="7" rx="1.5"/><path d="M14 10.5h7.5V18M10.5 14v7.5H18"/></g></svg>;
}

/** Pages without their own `nav` (the workspace and sign-in) get a Docs link next to the theme switch. */
export default function Header({ children, nav }: { children: ReactNode; nav?: ReactNode }) {
  return <header className="site-header">
    <a className="brand" href="/" aria-label="Mockdata home">
      <Logo />
      <span>mockdata<span className="brand-caption">Schema to synthetic data</span></span>
    </a>
    {nav}
    <div className="header-account">{!nav && <a className="header-link" href="/docs">Docs</a>}<ThemeToggle />{children}</div>
  </header>;
}
