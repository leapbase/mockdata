import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import AuthGate from "./AuthGate";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/geist-mono/400.css";
import "./styles.css";

const App = lazy(() => import("./App"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <Suspense fallback={<div className="workspace-empty" role="status">Loading workspace…</div>}>
        <App />
      </Suspense>
    </AuthGate>
  </StrictMode>,
);
