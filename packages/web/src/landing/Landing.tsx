import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import Header from "../components/Header";
import type { Slots } from "../slots";
import { navigateTabs } from "../tabs";
import { useLocale } from "../i18n";
import { CLI_SNIPPET, FEATURE_ICONS, LLM_SNIPPET, MCP_COMMAND, MCP_TOOLS, SAMPLE_COLUMNS, SAMPLE_ROWS, SCHEMA_SNIPPET, SOURCE_URL } from "./content";
import { LANDING_COPY, type LandingCopy } from "./copy";
import { DIAGRAM } from "./diagram";

// The workspace's own diagram (React Flow + ELK), fetched only when its section comes near the screen.
const SchemaDiagram = lazy(() => import("../components/SchemaDiagram"));
import "./landing.css";

const ICONS: Record<(typeof FEATURE_ICONS)[number], ReactNode> = {
  link: <><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h6.5a2.5 2.5 0 0 1 2.5 2.5V15" /></>,
  rule: <><path d="M4 7h16M4 12h10M4 17h6" /><path d="m15 16 2 2 4-4" /></>,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  db: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>,
  seed: <><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" /><path d="M18 3v4h-4M6 21v-4h4" /></>,
  agent: <><rect x="5" y="8" width="14" height="11" rx="3" /><path d="M12 8V4M9 13h.01M15 13h.01M9.5 16.5h5" /></>,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}

/** Inline `code` in the copy above becomes <code>. */
function Rich({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part))}</>;
}

const SNIPPETS = [
  { id: "schema", text: SCHEMA_SNIPPET },
  { id: "ai", text: null },
  { id: "cli", text: CLI_SNIPPET },
] as const;

/** Where the model-written column starts in the snippet; from there on it is highlighted. */
const LLM_AT = LLM_SNIPPET.indexOf("      body:");

/** The AI tab: columns a model writes, and agents over MCP, side by side. */
function AiPanel({ t }: { t: LandingCopy["ai"] }) {
  return <div className="ai-panel">
    <section aria-labelledby="ai-llm-title">
      <h3 id="ai-llm-title"><Icon name="spark" />{t.llmTitle}</h3>
      <p><Rich text={t.llmIntro} /></p>
      <pre className="code"><code>{LLM_SNIPPET.slice(0, LLM_AT)}<mark>{LLM_SNIPPET.slice(LLM_AT)}</mark></code></pre>
      <ul>{t.llmPoints.map((p) => <li key={p}><Rich text={p} /></li>)}</ul>
      <a href="/docs/llm">{t.llmMore} →</a>
    </section>
    <section aria-labelledby="ai-mcp-title">
      <h3 id="ai-mcp-title"><Icon name="agent" />{t.mcpTitle}</h3>
      <p>{t.mcpIntro}</p>
      <pre className="code"><code>{MCP_COMMAND}</code></pre>
      <p className="ai-tools-label">{t.toolsLabel}</p>
      <ul className="ai-tools">{MCP_TOOLS.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul>
      <ul>{t.mcpPoints.map((p) => <li key={p}>{p}</li>)}</ul>
      <a href="/docs/mcp">{t.mcpMore} →</a>
    </section>
  </div>;
}

/** Loads the diagram once the section is within a screen of view; without IntersectionObserver it stays a placeholder. */
function DiagramPreview({ t }: { t: LandingCopy["diagram"] }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !box.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "600px 0px" });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  const placeholder = <p className="landing-diagram-loading" role="status">{t.loading}</p>;
  return <figure className="landing-diagram card" aria-label={t.title}>
    <div ref={box} className="landing-diagram-canvas">{near ? <Suspense fallback={placeholder}><SchemaDiagram data={DIAGRAM} embedded /></Suspense> : placeholder}</div>
    <figcaption>{t.caption}</figcaption>
  </figure>;
}

/** Everyone goes straight into the workspace; a hosted shell passes its own hook to ask signed-out visitors to sign in. */
const useLocalCta: NonNullable<Slots["useLandingCta"]> = (t) => ({ primary: t.cta.openWorkspace, nav: t.cta.openWorkspace });

export default function Landing({ useCta = useLocalCta }: { useCta?: Slots["useLandingCta"] }) {
  const t = LANDING_COPY[useLocale()];
  const cta = useCta!(t);
  const [tab, setTab] = useState<(typeof SNIPPETS)[number]["id"]>("schema");
  const snippet = SNIPPETS.find((s) => s.id === tab)!;

  return (
    <div className="landing">
      <Header
        localized
        nav={
          <nav className="landing-nav" aria-label={t.nav.sections}>
            <a href="#how">{t.nav.how}</a>
            <a href="#snippets" onClick={() => setTab("ai")}>{t.nav.ai}</a>
            <a href="#features">{t.nav.features}</a>
            <a href="#use-cases">{t.nav.useCases}</a>
            <a href="#faq">{t.nav.faq}</a>
            <a href="/docs">{t.nav.docs}</a>
          </nav>
        }
      >
        <a className="button primary" href="/app">{cta.nav}</a>
      </Header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="pill">{t.hero.pill}</p>
            <h1 id="hero-title">{t.hero.title} <span>{t.hero.titleAccent}</span></h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="hero-actions">
              <a className="button primary large" href="/app">{cta.primary}</a>
              <a className="button large" href="#snippets">{t.hero.seeSchema}</a>
            </div>
            <ul className="hero-facts" aria-label={t.hero.factsLabel}>
              {t.hero.facts.map((f) => <li key={f}>{f}</li>)}
            </ul>
          </div>

          <figure className="hero-demo" aria-label={t.hero.demoLabel}>
            <div className="window-bar" aria-hidden="true"><i /><i /><i /><span>shop.yaml</span></div>
            <pre className="code"><code>{SCHEMA_SNIPPET.split("\n").slice(9).join("\n")}</code></pre>
            <div className="demo-result">
              <div className="demo-caption"><strong>orders</strong><span>{t.hero.demoCaption}</span></div>
              <div className="demo-table">
                <table>
                  <thead><tr>{SAMPLE_COLUMNS.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                  <tbody>
                    {SAMPLE_ROWS.map((row) => (
                      <tr key={row[0]}>{row.map((v, i) => <td key={i} className={v === null ? "null" : SAMPLE_COLUMNS[i] === "customer_id" ? "fk" : undefined}>{v === null ? "null" : String(v)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </figure>
        </section>

        <section id="how" className="band" aria-labelledby="how-title">
          <header className="section-head">
            <p className="eyebrow">{t.how.eyebrow}</p>
            <h2 id="how-title">{t.how.title}</h2>
            <p>{t.how.intro}</p>
          </header>
          <ol className="steps">
            {t.how.steps.map((s, i) => (
              <li key={s.title} className="card">
                <span className="step-number" aria-hidden="true">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="diagram" aria-labelledby="diagram-title">
          <header className="section-head">
            <p className="eyebrow">{t.diagram.eyebrow}</p>
            <h2 id="diagram-title">{t.diagram.title}</h2>
            <p>{t.diagram.intro}</p>
          </header>
          <DiagramPreview t={t.diagram} />
        </section>

        <section id="features" className="band" aria-labelledby="features-title">
          <header className="section-head">
            <p className="eyebrow">{t.features.eyebrow}</p>
            <h2 id="features-title">{t.features.title}</h2>
            <p>{t.features.intro}</p>
          </header>
          <ul className="feature-grid">
            {t.features.items.map((f, i) => (
              <li key={f.title} className="card">
                <span className="feature-icon"><Icon name={FEATURE_ICONS[i]!} /></span>
                <h3>{f.title}</h3>
                <p><Rich text={f.body} /></p>
              </li>
            ))}
          </ul>
        </section>

        <section id="snippets" aria-labelledby="snippets-title">
          <header className="section-head">
            <p className="eyebrow">{t.snippets.eyebrow}</p>
            <h2 id="snippets-title">{t.snippets.title}</h2>
            <p>{t.snippets.intro}</p>
          </header>
          <div className="snippet card">
            <div className="snippet-tabs" role="tablist" aria-label={t.snippets.tabsLabel} onKeyDown={navigateTabs}>
              {SNIPPETS.map((s) => (
                <button key={s.id} type="button" role="tab" id={`snippet-tab-${s.id}`} aria-selected={tab === s.id} aria-controls="snippet-panel" tabIndex={tab === s.id ? 0 : -1} onClick={() => setTab(s.id)}>
                  {s.id === "ai" && <Icon name="spark" />}{t.snippets[s.id]}
                </button>
              ))}
            </div>
            {snippet.text === null
              ? <div id="snippet-panel" role="tabpanel" aria-labelledby={`snippet-tab-${snippet.id}`} tabIndex={0}><AiPanel t={t.ai} /></div>
              : <pre className="code" id="snippet-panel" role="tabpanel" aria-labelledby={`snippet-tab-${snippet.id}`} tabIndex={0}><code>{snippet.text}</code></pre>}
          </div>
        </section>

        <section id="use-cases" className="band" aria-labelledby="use-cases-title">
          <header className="section-head">
            <p className="eyebrow">{t.useCases.eyebrow}</p>
            <h2 id="use-cases-title">{t.useCases.title}</h2>
          </header>
          <ul className="use-cases">
            {t.useCases.items.map((u) => (
              <li key={u.title} className="card">
                <h3>{u.title}</h3>
                <p>{u.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="faq" aria-labelledby="faq-title">
          <header className="section-head">
            <p className="eyebrow">{t.faq.eyebrow}</p>
            <h2 id="faq-title">{t.faq.title}</h2>
          </header>
          <div className="faq">
            {t.faq.items.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">{t.closing.title}</h2>
          <p>{t.closing.body}</p>
          <a className="button primary large" href="/app">{cta.primary}</a>
        </section>
      </main>

      <footer className="landing-footer">
        <span>{t.footer.tagline}</span>
        <span className="landing-footer-links">
          <a href="/app">{t.footer.workspace}</a>
          <a href="/docs">{t.nav.docs}</a>
          <a href={SOURCE_URL}>{t.footer.source}</a>
          <a href={`${SOURCE_URL}/blob/develop/LICENSE`}>AGPL-3.0</a>
        </span>
      </footer>
    </div>
  );
}
