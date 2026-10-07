/**
 * The web package as a library, for a hosted shell that builds its own Vite entry on top of the open workspace
 * (see `mountApp` and `Slots`). Source files are consumed directly, so the shell's Vite and TypeScript compile them.
 */
export { mountApp } from "./mount";
export type { Cta, Slots } from "./slots";
export { default as Root } from "./Root";
export { default as LocalGate } from "./components/LocalGate";
export { default as Header } from "./components/Header";
export { default as Modal } from "./components/Modal";
export { copyText } from "./components/DiagramMenu";
export { messageOf } from "./hooks";
export { ApiError, json, setOnUnauthorized } from "./api";
export type { LandingCopy } from "./landing/copy";
export { SOURCE_URL } from "./landing/content";
export type { Locale } from "./i18n";
export type { DocPage, Block, Section } from "./docs/content";
export type { DocsExtension, LandingCopyFn } from "./slots";
export type { Dictionary } from "./docs/translate";
