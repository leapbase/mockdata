import type { ReactNode } from "react";
import Header from "./Header";

/** The default around the workspace: no sign-in, just the page chrome. A hosted shell passes its own `gate` to `Root`. */
export default function LocalGate({ children }: { children: ReactNode }) {
  return (
    <div className="site-shell">
      <Header><span className="workspace-label"><i />Local workspace</span></Header>
      {children}
    </div>
  );
}
