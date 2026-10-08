import type { ReactNode } from "react";
import { SOURCE_URL } from "../source";
import Header from "./Header";

/** The default around the workspace: no sign-in, just the page chrome. A hosted shell passes its own `gate` to `Root`. */
export default function LocalGate({ children }: { children: ReactNode }) {
  return (
    <div className="site-shell">
      <Header><a className="header-link" href={SOURCE_URL}>Source (AGPL-3.0)</a><span className="workspace-label"><i />Local workspace</span></Header>
      {children}
    </div>
  );
}
