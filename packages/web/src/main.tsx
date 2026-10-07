import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AuthGate, { useAccountCta } from "./AuthGate";
import Root from "./Root";
import { applyTheme, storedTheme } from "./theme";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/geist-mono/400.css";
import "./styles.css";

// Before the first paint, so a saved dark theme never flashes light.
applyTheme(storedTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root gate={AuthGate} useLandingCta={useAccountCta} />
  </StrictMode>,
);
