import type { ComponentType, ReactNode } from "react";
import type { Locale } from "./i18n";
import type { DocPage } from "./docs/content";
import type { Dictionary } from "./docs/translate";
import type { LandingCopy } from "./landing/copy";

/** Labels for the landing page's calls to action. */
export interface Cta {
  /** The big buttons. */
  primary: string;
  /** The link in the nav bar. */
  nav: string;
}

/** Picks the landing copy to show for a locale, typically the base with hosted wording swapped in. */
export type LandingCopyFn = (base: LandingCopy, locale: Locale) => LandingCopy;

/** What a hosted shell adds to the documentation. */
export interface DocsExtension {
  /** Receives the open pages and returns the pages to show: add a page, or edit a paragraph in one. Keep this function stable. */
  pages?: (base: DocPage[]) => DocPage[];
  /** Translations of the strings the extension adds, merged over the open dictionary (English fills any gap). Loaded on demand. */
  dictionaries?: Partial<Record<Exclude<Locale, "en">, () => Promise<Dictionary>>>;
}

/**
 * What a hosted shell may supply to `Root` (the open build supplies none): the component that wraps the workspace
 * (sign-in, account menu), the landing page's call-to-action labels and copy, and extra documentation.
 * Functions and objects must be stable (module-level), not rebuilt on every render.
 */
export interface Slots {
  /** Serve the landing page at "/". The open build leaves this off and opens the workspace there; a hosted shell sets it. */
  landing?: boolean;
  gate?: ComponentType<{ children: ReactNode }>;
  useLandingCta?: (copy: LandingCopy, locale: Locale) => Cta;
  /** Loads a function returning the landing copy to show for a locale, typically the base with hosted wording swapped in. */
  landingCopy?: () => Promise<LandingCopyFn>;
  /** Loads extra documentation. Both loaders run beside the page that uses them, off the startup path. */
  docs?: () => Promise<DocsExtension>;
}
