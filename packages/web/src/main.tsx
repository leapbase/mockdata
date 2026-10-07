import AuthGate, { useAccountCta } from "./hosted/AuthGate";
import { mountApp } from "./mount";
// After mount, which loads styles.css: these rules extend it and must come later in the cascade.
import "./hosted/hosted.css";

mountApp({
  gate: AuthGate,
  useLandingCta: useAccountCta,
  // Loaded beside the landing page and the docs, not at startup.
  landingCopy: () => import("./hosted/landing").then((m) => m.hostedLandingCopy),
  docs: () => import("./hosted/docs").then((m) => m.HOSTED_DOCS),
});
