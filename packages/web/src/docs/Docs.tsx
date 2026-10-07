import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Header from "../components/Header";
import { GROUPS, PAGES, SOURCE_URL, pageHref, type Block, type DocPage, type IconName } from "./content";
import "./docs.css";

const ICONS: Record<IconName, ReactNode> = {
  book: <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />,
  rocket: <><path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" /><path d="M9 15l-3-3c2-6 7-9 13-9 0 6-3 11-9 13z" /><circle cx="14.5" cy="9.5" r="1.5" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>,
  link: <><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h6.5a2.5 2.5 0 0 1 2.5 2.5V15" /></>,
  rule: <><path d="M4 7h16M4 12h10M4 17h6" /><path d="m15 16 2 2 4-4" /></>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  import: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  agent: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V4M9 13h.01M15 13h.01M9.5 16.5h5" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  network: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5M12 12l-6 5M12 12l6 5" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></>,
};

function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

/** `code`, **bold** and [text](href) inside the copy. */
export function Rich({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} {...(link[2]!.startsWith("http") ? { rel: "noreferrer" } : {})}>{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  })}</>;
}

/** Plain text of the copy, for search: markup dropped, link text kept. */
const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|`/g, "");
function blockText(b: Block): string {
  if ("p" in b) return plain(b.p);
  if ("code" in b) return b.code;
  if ("table" in b) return [...b.table.head, ...b.table.rows.flat()].map(plain).join(" ");
  if ("list" in b) return b.list.map(plain).join(" ");
  if ("note" in b) return `${b.title ?? ""} ${plain(b.note)}`;
  return b.cards.map((c) => `${c.title} ${c.body}`).join(" ");
}

export type SearchResult = { href: string; page: string; section?: string; snippet: string };
type Entry = { href: string; page: string; section?: string; title: string; text: string };
const INDEX: Entry[] = PAGES.flatMap((p) => [
  { href: pageHref(p.slug), page: p.title, title: p.title, text: p.summary },
  ...p.sections.map((s) => ({ href: `${pageHref(p.slug)}#${s.id}`, page: p.title, section: s.title, title: s.title, text: s.blocks.map(blockText).join(" ") })),
]);

/** Every word must appear in a page or section; titles count most, then the exact phrase, then how often each word recurs. */
export function searchDocs(query: string, limit = 8): SearchResult[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored = INDEX.flatMap((e) => {
    const title = e.title.toLowerCase(), text = e.text.toLowerCase(), all = `${title} ${e.page.toLowerCase()} ${text}`;
    if (!words.every((w) => all.includes(w))) return [];
    // Repeats in the body count a little (at most 3 each), so a section about a word beats one that mentions it once.
    const repeats = (w: string) => Math.min(3, text.split(w).length - 1);
    const score = words.reduce((n, w) => n + (title.includes(w) ? 5 : 0) + (title.startsWith(w) ? 3 : 0) + repeats(w), 0) + (all.includes(q) ? 4 : 0) + (e.section ? 0 : 1);
    const at = text.indexOf(words[0]!);
    const snippet = at < 0 ? e.text.slice(0, 110) : `${at > 40 ? "…" : ""}${e.text.slice(Math.max(0, at - 40), at + 90).trim()}…`;
    return [{ score, result: { href: e.href, page: e.page, section: e.section, snippet } }];
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.result);
}

export const slugFromPath = (pathname: string) => pathname.replace(/^\/docs\/?/, "").replace(/\/$/, "");

function CodeBlock({ code, title }: { code: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* the text stays selectable */ }
  }
  return <div className="docs-code">
    <div className={`docs-code-bar${title ? "" : " untitled"}`}>{title && <span>{title}</span>}<button type="button" onClick={copy} aria-label={title ? `Copy ${title}` : "Copy code"}>{copied ? "Copied" : "Copy"}</button></div>
    <pre><code>{code}</code></pre>
  </div>;
}

function BlockView({ block }: { block: Block }) {
  if ("p" in block) return <p><Rich text={block.p} /></p>;
  if ("code" in block) return <CodeBlock code={block.code} title={block.title} />;
  if ("table" in block) return <div className="docs-table"><table>
    <thead><tr>{block.table.head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
    <tbody>{block.table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Rich text={c} /></td>)}</tr>)}</tbody>
  </table></div>;
  if ("list" in block) {
    const items = block.list.map((t, i) => <li key={i}><Rich text={t} /></li>);
    return block.ordered ? <ol className="docs-steps">{items}</ol> : <ul>{items}</ul>;
  }
  if ("note" in block) return <aside className={`docs-note${block.tone === "warn" ? " warn" : ""}`}>
    {block.title && <strong>{block.title}</strong>}<p><Rich text={block.note} /></p>
  </aside>;
  return <ul className="docs-cards">{block.cards.map((c) => <li key={c.href}><a href={c.href}><strong>{c.title}</strong><span>{c.body}</span></a></li>)}</ul>;
}

function Search({ onPick }: { onPick: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchDocs(query), [query]);
  useEffect(() => setActive(0), [query]);
  // "/" jumps to search from anywhere on the page, as on most documentation sites.
  useEffect(() => {
    function key(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) { e.preventDefault(); input.current?.focus(); }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function pick(href: string) { setQuery(""); onPick(href); }
  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") setQuery("");
    else if (e.key === "ArrowDown" && results.length) { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
    else if (e.key === "ArrowUp" && results.length) { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
    else if (e.key === "Enter" && results[active]) { e.preventDefault(); pick(results[active]!.href); }
  }
  const open = query.trim() !== "";
  return <div className="docs-search">
    <input ref={input} type="search" placeholder="Search docs…" aria-label="Search docs" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
      role="combobox" aria-expanded={open} aria-controls="docs-search-results" aria-activedescendant={open && results[active] ? `docs-result-${active}` : undefined} aria-autocomplete="list" />
    <kbd aria-hidden="true">/</kbd>
    {open && <ul id="docs-search-results" role="listbox" aria-label="Search results">
      {results.length ? results.map((r, i) => <li key={r.href} id={`docs-result-${i}`} role="option" aria-selected={i === active}
        onMouseDown={(e) => { e.preventDefault(); pick(r.href); }} onMouseEnter={() => setActive(i)}>
        <strong>{r.section ? <>{r.page} <span>›</span> {r.section}</> : r.page}</strong><span>{r.snippet}</span>
      </li>) : <li className="empty" role="presentation">No results for “{query.trim()}”</li>}
    </ul>}
  </div>;
}

/** The section heading nearest the top of the viewport, for the "On this page" highlight. */
function useActiveSection(page: DocPage | undefined): string | undefined {
  const [active, setActive] = useState<string>();
  useEffect(() => {
    setActive(page?.sections[0]?.id);
    if (!page || typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = page.sections.find((s) => seen.get(s.id));
      if (first) setActive(first.id);
    }, { rootMargin: "-72px 0px -60% 0px" });
    for (const s of page.sections) { const el = document.getElementById(s.id); if (el) observer.observe(el); }
    return () => observer.disconnect();
  }, [page]);
  return active;
}

export default function Docs({ location = window.location }: { location?: Pick<Location, "pathname" | "hash"> }) {
  const [path, setPath] = useState({ pathname: location.pathname, hash: location.hash });
  const [menuOpen, setMenuOpen] = useState(false);
  const slug = slugFromPath(path.pathname);
  const index = PAGES.findIndex((p) => p.slug === slug);
  const page = PAGES[index];
  const active = useActiveSection(page);

  useEffect(() => {
    const onPop = () => setPath({ pathname: window.location.pathname, hash: window.location.hash });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => { document.title = page ? `${slug ? `${page.title} · ` : ""}mockdata docs` : "Page not found · mockdata docs"; }, [page, slug]);
  // After a page change, go to the requested section or the top.
  useEffect(() => {
    const target = path.hash && document.getElementById(decodeURIComponent(path.hash.slice(1)));
    if (target) target.scrollIntoView?.();
    else window.scrollTo?.(0, 0);
  }, [path]);

  function go(href: string) {
    const url = new URL(href, window.location.origin);
    if (url.pathname !== window.location.pathname || url.hash !== window.location.hash) window.history.pushState(null, "", url.pathname + url.hash);
    setPath({ pathname: url.pathname, hash: url.hash });
    setMenuOpen(false);
  }
  /** Links within /docs change the page in place; everything else (the workspace, GitHub) is an ordinary link. */
  function onClick(e: ReactMouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!a || !href || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    if (href.startsWith("#")) { e.preventDefault(); go(path.pathname + href); return; }
    if (href === "/docs" || href.startsWith("/docs/") || href.startsWith("/docs#")) { e.preventDefault(); go(href); }
  }

  const prev = index > 0 ? PAGES[index - 1] : undefined;
  const next = index >= 0 && index < PAGES.length - 1 ? PAGES[index + 1] : undefined;

  return <div className="docs" onClick={onClick}>
    <Header nav={<nav className="docs-topnav" aria-label="Site"><a href="/">Home</a><a href="/docs" aria-current="page">Docs</a><a href={SOURCE_URL}>GitHub</a></nav>}>
      <a className="button primary" href="/app">Open workspace</a>
    </Header>
    <div className="docs-body">
      <button type="button" className="docs-menu-button" aria-expanded={menuOpen} aria-controls="docs-sidebar" onClick={() => setMenuOpen((o) => !o)}>
        {menuOpen ? "Close menu" : "Menu"}{page && <span> · {page.slug ? page.title : "Overview"}</span>}
      </button>
      <aside id="docs-sidebar" className={`docs-sidebar${menuOpen ? " open" : ""}`} aria-label="Documentation">
        <Search onPick={go} />
        <nav aria-label="Documentation pages">
          {GROUPS.map((g) => <section key={g}>
            <h2>{g}</h2>
            <ul>{PAGES.filter((p) => p.group === g).map((p) => <li key={p.slug}>
              <a href={pageHref(p.slug)} aria-current={p === page ? "page" : undefined}><Icon name={p.icon} />{p.slug ? p.title : "Overview"}</a>
            </li>)}</ul>
          </section>)}
        </nav>
      </aside>

      {page ? <>
        <main className="docs-article" id="docs-main">
          <article>
            <header><p className="docs-group">{page.group}</p><h1>{page.title}</h1><p className="docs-summary">{page.summary}</p></header>
            {page.sections.map((s) => <section key={s.id} aria-labelledby={s.id}>
              <h2 id={s.id}><a href={`#${s.id}`} className="docs-anchor" aria-hidden="true" tabIndex={-1}>#</a>{s.title}</h2>
              {s.blocks.map((b, i) => <BlockView key={i} block={b} />)}
            </section>)}
          </article>
          <nav className="docs-pager" aria-label="Previous and next page">
            {prev ? <a href={pageHref(prev.slug)} rel="prev"><span>Previous</span> {prev.slug ? prev.title : "Overview"}</a> : <span />}
            {next && <a href={pageHref(next.slug)} rel="next" className="next"><span>Next</span> {next.title}</a>}
          </nav>
          <footer className="docs-footer">
            <span>mockdata · open source under AGPL-3.0</span>
            <a href={`${SOURCE_URL}/blob/develop/packages/web/src/docs/content.ts`}>Edit this page on GitHub</a>
          </footer>
        </main>
        <nav className="docs-toc" aria-label="On this page">
          <h2>On this page</h2>
          <ul>{page.sections.map((s) => <li key={s.id}><a href={`#${s.id}`} aria-current={active === s.id ? "location" : undefined}>{s.title}</a></li>)}</ul>
        </nav>
      </> : <main className="docs-article" id="docs-main">
        <article><header><h1>Page not found</h1><p className="docs-summary">There is no documentation page at <code>{path.pathname}</code>.</p></header>
          <p><a href="/docs">Go to the documentation home</a> or search above.</p></article>
      </main>}
    </div>
  </div>;
}
