import { useEffect, useState, type ReactNode } from "react";
import { getMe, type Me } from "../api";
import Header from "../components/Header";
import { navigateTabs } from "../tabs";
import { CLI_SNIPPET, FAQ, FEATURES, MCP_SNIPPET, SAMPLE_COLUMNS, SAMPLE_ROWS, SCHEMA_SNIPPET, SOURCE_URL, STEPS, USE_CASES } from "./content";
import "./landing.css";

const ICONS: Record<(typeof FEATURES)[number]["icon"], ReactNode> = {
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
  { id: "schema", label: "Schema (YAML)", text: SCHEMA_SNIPPET },
  { id: "cli", label: "CLI", text: CLI_SNIPPET },
  { id: "mcp", label: "MCP", text: MCP_SNIPPET },
] as const;

/** Labels for the calls to action: a signed-out visitor in accounts mode is asked to sign in, everyone else goes straight in. */
function useCta(): { primary: string; nav: string } {
  const [me, setMe] = useState<Me | undefined>();
  useEffect(() => {
    let live = true;
    getMe().then((m) => live && setMe(m), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const signedOut = me?.auth.accountsEnabled && !me.user;
  return signedOut ? { primary: "Get started", nav: "Sign in" } : { primary: "Open workspace", nav: "Open workspace" };
}

export default function Landing() {
  const cta = useCta();
  const [tab, setTab] = useState<(typeof SNIPPETS)[number]["id"]>("schema");
  const snippet = SNIPPETS.find((s) => s.id === tab)!;

  return (
    <div className="landing">
      <Header
        nav={
          <nav className="landing-nav" aria-label="Page sections">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#use-cases">Use cases</a>
            <a href="#faq">FAQ</a>
            <a href="/docs">Docs</a>
          </nav>
        }
      >
        <a className="button primary" href="/app">{cta.nav}</a>
      </Header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="pill">CLI · web UI · MCP server</p>
            <h1 id="hero-title">Realistic, related test data <span>from one schema</span></h1>
            <p className="lead">
              Deterministic generators handle keys, numbers and dates, every foreign key points at a real row, and an LLM writes only the free-text columns you choose.
            </p>
            <div className="hero-actions">
              <a className="button primary large" href="/app">{cta.primary}</a>
              <a className="button large" href="#snippets">See the schema</a>
            </div>
            <ul className="hero-facts" aria-label="Highlights">
              <li>Seeded, reproducible output</li>
              <li>Constraints re-validated</li>
              <li>Runs locally</li>
            </ul>
          </div>

          <figure className="hero-demo" aria-label="A schema and the rows it generates">
            <div className="window-bar" aria-hidden="true"><i /><i /><i /><span>shop.yaml</span></div>
            <pre className="code"><code>{SCHEMA_SNIPPET.split("\n").slice(9).join("\n")}</code></pre>
            <div className="demo-result">
              <div className="demo-caption"><strong>orders</strong><span>first 5 of 100 rows · seed 42</span></div>
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
            <p className="eyebrow">How it works</p>
            <h2 id="how-title">From schema to dataset in three steps</h2>
            <p>Describe the tables once; mockdata works out the order, the keys and the rules.</p>
          </header>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="card">
                <span className="step-number" aria-hidden="true">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="features" aria-labelledby="features-title">
          <header className="section-head">
            <p className="eyebrow">Features</p>
            <h2 id="features-title">More than random rows</h2>
            <p>Constraints are enforced by code and checked again, not left to a prompt.</p>
          </header>
          <ul className="feature-grid">
            {FEATURES.map((f) => (
              <li key={f.title} className="card">
                <span className="feature-icon"><Icon name={f.icon} /></span>
                <h3>{f.title}</h3>
                <p><Rich text={f.body} /></p>
              </li>
            ))}
          </ul>
        </section>

        <section id="snippets" className="band" aria-labelledby="snippets-title">
          <header className="section-head">
            <p className="eyebrow">Use it your way</p>
            <h2 id="snippets-title">One schema, three ways in</h2>
            <p>Edit and preview in the web UI, script it with the CLI, or connect an agent to the hosted MCP endpoint.</p>
          </header>
          <div className="snippet card">
            <div className="snippet-tabs" role="tablist" aria-label="Examples" onKeyDown={navigateTabs}>
              {SNIPPETS.map((s) => (
                <button key={s.id} type="button" role="tab" id={`snippet-tab-${s.id}`} aria-selected={tab === s.id} aria-controls="snippet-panel" tabIndex={tab === s.id ? 0 : -1} onClick={() => setTab(s.id)}>
                  {s.label}
                </button>
              ))}
            </div>
            <pre className="code" id="snippet-panel" role="tabpanel" aria-labelledby={`snippet-tab-${snippet.id}`} tabIndex={0}><code>{snippet.text}</code></pre>
          </div>
        </section>

        <section id="use-cases" aria-labelledby="use-cases-title">
          <header className="section-head">
            <p className="eyebrow">Use cases</p>
            <h2 id="use-cases-title">Where it fits</h2>
          </header>
          <ul className="use-cases">
            {USE_CASES.map((u) => (
              <li key={u.title} className="card">
                <h3>{u.title}</h3>
                <p>{u.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="faq" className="band" aria-labelledby="faq-title">
          <header className="section-head">
            <p className="eyebrow">FAQ</p>
            <h2 id="faq-title">Questions, answered</h2>
          </header>
          <div className="faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">Stop hand-writing fixtures.</h2>
          <p>Describe your tables once and generate as much related data as you need.</p>
          <a className="button primary large" href="/app">{cta.primary}</a>
        </section>
      </main>

      <footer className="landing-footer">
        <span>mockdata · schema to synthetic data</span>
        <span className="landing-footer-links">
          <a href="/app">Workspace</a>
          <a href="/docs">Docs</a>
          <a href={SOURCE_URL}>Source on GitHub</a>
          <a href={`${SOURCE_URL}/blob/develop/LICENSE`}>AGPL-3.0</a>
        </span>
      </footer>
    </div>
  );
}
