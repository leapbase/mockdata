import type { ComponentType, ReactNode } from "react";
import type { LandingCopy } from "./landing/copy";

/** Labels for the landing page's calls to action. */
export interface Cta {
  /** The big buttons. */
  primary: string;
  /** The link in the nav bar. */
  nav: string;
}

/**
 * What a hosted shell may supply to `Root` (the open build supplies none): the component that wraps the workspace
 * (sign-in, account menu) and the hook that labels the landing page's calls to action.
 */
export interface Slots {
  gate?: ComponentType<{ children: ReactNode }>;
  useLandingCta?: (copy: LandingCopy) => Cta;
}
