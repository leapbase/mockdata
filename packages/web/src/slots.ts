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

/** What the workspace hands a hosted shell's library panel (a place to share and fetch schemas). */
export interface LibraryProps {
  /** The schema text in the editor, and its file name ("" for an untitled draft). */
  text: string;
  name: string;
  /** Open `text` as a new unsaved draft called `file` (asks first when there are unsaved changes). */
  onUse: (file: string, text: string) => void;
  onClose: () => void;
}

/** A schema the workspace opens as an unsaved draft when it starts: `file` is its name, `text` its content. */
export interface InitialDraft {
  file: string;
  text: string;
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
  /** A panel the workspace opens from a "Library" button (sidebar) and a "Browse the library" button (empty draft). Absent in the open build. Keep it stable (module-level). */
  library?: ComponentType<LibraryProps>;
  /** Called once when the workspace starts; a draft it resolves to opens like a library schema (for links such as "open this schema in the workspace"). Keep it stable (module-level). */
  initialDraft?: () => Promise<InitialDraft | null>;
}
