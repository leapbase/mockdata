import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Root from "./Root";
import type { Slots } from "./slots";
import { applyTheme, storedTheme } from "./theme";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/geist-mono/400.css";
import "./styles.css";

/**
 * Start the web app: the saved theme (before the first paint, so a dark theme never flashes light), the bundled
 * fonts and styles, then `Root` with whatever a hosted shell supplies. The open build's `main.tsx` supplies nothing.
 */
export function mountApp(slots: Slots = {}, container: HTMLElement = document.getElementById("root")!): () => void {
  applyTheme(storedTheme());
  const root = createRoot(container);
  root.render(
    <StrictMode>
      <Root {...slots} />
    </StrictMode>,
  );
  return () => root.unmount();
}
