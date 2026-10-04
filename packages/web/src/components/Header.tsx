import type { ReactNode } from "react";

export default function Header({ children }: { children: ReactNode }) {
  return <header className="site-header">
    <a className="brand" href="/" aria-label="Mockdata home">
      <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor" /><g fill="none" stroke="white" strokeWidth="1.6"><rect x="7" y="7" width="7" height="7" rx="1.5"/><rect x="18" y="18" width="7" height="7" rx="1.5"/><path d="M14 10.5h7.5V18M10.5 14v7.5H18"/></g></svg>
      <span>mockdata<span className="brand-caption">Schema to synthetic data</span></span>
    </a>
    <div className="header-account">{children}</div>
  </header>;
}
