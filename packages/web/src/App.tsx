import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import Editor from "./components/Editor";
import ExportDialog from "./components/ExportDialog";
import GenerateBar from "./components/GenerateBar";
import InferDialog from "./components/InferDialog";
import Preview from "./components/Preview";
import Sidebar from "./components/Sidebar";
import SchemaDiagram from "./components/SchemaDiagram";
import { useDrawer, useNarrow } from "./drawers";
import { navigateTabs } from "./tabs";
import { messageOf, useDebounced } from "./hooks";

const STARTER = `seed: 1
tables:
  customers:
    rows: 10
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: person.fullName }
  orders:
    rows: 30
    columns:
      id: { type: integer, primaryKey: true }
      customer_id: { type: integer, ref: customers.id }
      total: { type: float, min: 5, max: 500 }
`;

export default function App({ debounceMs = 400 }: { debounceMs?: number }) {
  const [files, setFiles] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState(STARTER);
  const [savedText, setSavedText] = useState(STARTER);
  const [check, setCheck] = useState<api.ValidateResult | null>(null);
  const [config, setConfig] = useState<api.Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [seed, setSeed] = useState("");
  const [rows, setRows] = useState("");
  const [preview, setPreview] = useState<api.Preview | null>(null);
  const [running, setRunning] = useState(false);
  const [llmOn, setLlmOn] = useState(false);
  const [progress, setProgress] = useState<api.Progress | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [dialog, setDialog] = useState<"export" | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"schemas" | "import">("schemas");
  const [schemaView, setSchemaView] = useState<"editor" | "diagram">("editor");
  const [generationOpen, setGenerationOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const narrow = useNarrow("(max-width: 1099px)");
  const mobile = useNarrow("(max-width: 767px)");
  const generationPanel = useRef<HTMLElement | null>(null);
  const sidebarPanel = useRef<HTMLElement | null>(null);
  const generateButton = useRef<HTMLButtonElement | null>(null);
  const schemaButton = useRef<HTMLButtonElement | null>(null);
  const closeGeneration = useCallback(() => { setGenerationOpen(false); generateButton.current?.focus(); }, []);
  const closeSidebar = useCallback(() => { setSidebarOpen(false); schemaButton.current?.focus(); }, []);
  useDrawer(generationPanel, generationOpen && narrow, closeGeneration);
  useDrawer(sidebarPanel, sidebarOpen && mobile, closeSidebar);

  const fail = useCallback((e: unknown) => setError(messageOf(e)), []);

  useEffect(() => {
    api.getFiles().then(setFiles).catch(fail);
    api.getConfig().then(setConfig).catch(fail);
  }, [fail]);

  const debounced = useDebounced(text, debounceMs);
  useEffect(() => {
    let stale = false;
    setValidating(true);
    setValidationError(null);
    api
      .validate(debounced)
      .then((r) => { if (!stale) { setCheck(r); setValidatedText(debounced); } })
      .catch((e) => { if (!stale) { setValidationError(messageOf(e)); fail(e); } })
      .finally(() => { if (!stale) setValidating(false); });
    return () => {
      stale = true;
    };
  }, [debounced, fail, validationAttempt]);

  const dirty = text !== savedText;

  /** Replacing the editor text would lose unsaved edits: ask first. */
  const okToDiscard = () => !dirty || window.confirm("Discard your unsaved changes?");

  // Closing the tab with unsaved edits asks too.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function open(p: string) {
    if (!okToDiscard()) return;
    try {
      const t = await api.getFile(p);
      setPath(p);
      setText(t);
      setSavedText(t);
      setWarnings([]);
      setError(null);
      closeSidebar();
    } catch (e) {
      fail(e);
    }
  }

  async function saveAs(p: string, create: boolean) {
    try {
      await api.putFile(p, text, create);
      setPath(p);
      setSavedText(text);
      setPendingSave(false);
      setFiles((prev) => (prev.includes(p) ? prev : [...prev, p].sort()));
      setError(null);
    } catch (e) {
      fail(e);
    }
  }

  function save() {
    if (path) void saveAs(path, false);
    else setPendingSave(true);
  }

  function runBody(): api.GenerateBody {
    return { text, seed: seed === "" ? undefined : Number(seed), rows: rows === "" ? undefined : Number(rows) };
  }

  async function generate() {
    setError(null);
    setRunning(true);
    const controller = new AbortController();
    abort.current = controller;
    if (!llmOn) {
      try {
        setPreview(await api.generate(runBody(), controller.signal));
      } catch (e) {
        setError(controller.signal.aborted ? "Cancelled: the tables shown are from the previous run." : messageOf(e));
      } finally {
        abort.current = null;
        setRunning(false);
      }
      return;
    }
    setProgress(null);
    try {
      setPreview(await api.streamGenerate(runBody(), setProgress, controller.signal));
    } catch (e) {
      // A cancelled run is discarded; the previous preview stays.
      setError(controller.signal.aborted ? "Cancelled: the tables shown are from the previous run." : messageOf(e));
    } finally {
      abort.current = null;
      setProgress(null);
      setRunning(false);
    }
  }

  // The schema's own llm block wins over the environment, so prefer the validation result.
  const llmState = check?.ok && check.llm ? check.llm : config?.llm;

  const errors = check && !check.ok ? (check.errors ?? []) : [];

  return (
    <div className={`app${generationOpen ? " generation-open" : ""}${sidebarOpen ? " sidebar-open" : ""}`}>
      {error && (
        <div role="alert" className="banner error">
          {error}
          <button aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {((generationOpen && narrow) || (sidebarOpen && mobile)) && <button className="drawer-scrim" aria-label="Close panel" onClick={() => { closeGeneration(); closeSidebar(); }} />}
      <aside className="sidebar" ref={sidebarPanel} aria-label="Schema navigation" role={mobile && sidebarOpen ? "dialog" : undefined} aria-modal={mobile && sidebarOpen ? true : undefined} tabIndex={-1}>
      <button className="sidebar-close icon-button" aria-label="Close schema navigation" onClick={closeSidebar}>×</button>
      <Sidebar
        files={files}
        active={path}
        dirty={dirty}
        forceNaming={pendingSave}
        onOpen={(p) => void open(p)}
        onCreate={(p) => void saveAs(p, true)}
        onSave={save}
        onInfer={() => setSidebarTab("import")}
        tab={sidebarTab}
        onTab={setSidebarTab}
        importContent={<InferDialog embedded dbEnv={config?.dbEnv ?? []} onResult={(r) => {
          if (!okToDiscard()) return;
          setPath(null); setText(r.schemaText); setSavedText(""); setPreview(null);
          setWarnings(r.warnings); setSidebarTab("schemas"); closeSidebar();
        }} />}
      />
      </aside>
      <main className="editor">
        <header className="workspace-toolbar">
          <button className="mobile-navigation icon-button" aria-label="Open schema navigation" ref={schemaButton} onClick={() => { setSidebarOpen(true); setGenerationOpen(false); }}>☰</button>
          <div className="schema-title"><span className="eyebrow">SCHEMA WORKSPACE</span><strong title={path ?? "Untitled schema"}>{path ?? "Untitled schema"}{dirty && <span className="unsaved-mark" title="Unsaved changes"> •</span>}</strong></div>
          <button className="primary open-generation" ref={generateButton} aria-label={running ? "Generate data (running)" : "Generate data"} aria-expanded={generationOpen} aria-controls="generation-panel" onClick={() => { setGenerationOpen(true); setSidebarOpen(false); }}>{running && <i className="running-dot" />}Generate data <span aria-hidden="true">→</span></button>
        </header>
        <div className="view-tabs" role="tablist" aria-label="Schema view" onKeyDown={navigateTabs}>
          <button role="tab" tabIndex={schemaView === "editor" ? 0 : -1} aria-selected={schemaView === "editor"} aria-controls="schema-editor" id="editor-tab" onClick={() => setSchemaView("editor")}>Editor</button>
          <button role="tab" tabIndex={schemaView === "diagram" ? 0 : -1} aria-selected={schemaView === "diagram"} aria-controls="schema-diagram" id="diagram-tab" onClick={() => setSchemaView("diagram")}>Diagram</button>
          <span className="view-hint">{schemaView === "editor" ? "Edit your schema in YAML or JSON" : "Explore tables and relationships"}</span>
        </div>
        <div className="schema-surface" id="schema-editor" role="tabpanel" aria-labelledby="editor-tab" hidden={schemaView !== "editor"}><Editor value={text} onChange={setText} errors={errors} /></div>
        {schemaView === "diagram" && <div className="schema-surface" id="schema-diagram" role="tabpanel" aria-labelledby="diagram-tab">
          {validationError ? <div className="workspace-empty"><h2>Validation unavailable</h2><p>{validationError}</p><button onClick={() => { setError(null); setValidationAttempt((n) => n + 1); }}>Retry validation</button></div> : validating || validatedText !== text ? <div className="workspace-empty"><p>Updating diagram…</p></div> : check?.ok && check.diagram ? <SchemaDiagram data={check.diagram} /> : <div className="workspace-empty"><h2>Diagram unavailable</h2><p>{check?.ok ? "Diagram metadata is unavailable. Rebuild and restart the server." : "Fix the schema in the editor to view its diagram."}</p><button onClick={() => setSchemaView("editor")}>Return to editor</button></div>}
        </div>}
        <div className="status">
          {check?.ok ? (
            <>
              <span>
                {check.tables!.length} table{check.tables!.length === 1 ? "" : "s"}
              </span>
              <span className="order">{check.order!.map((l) => l.join(", ")).join(" → ")}</span>
              {check.deferred!.length > 0 && <span className="note">deferred FKs: {check.deferred!.join(", ")}</span>}
            </>
          ) : (
            errors.map((e, i) => (
              <span key={i} className="error">
                {e.message}
              </span>
            ))
          )}
        </div>
        {warnings.length > 0 && (
          <ul className="warnings" aria-label="Inference warnings">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </main>
      <section className="preview generation-panel" id="generation-panel" ref={generationPanel} hidden={!generationOpen} aria-label="Data generation" role={narrow && generationOpen ? "dialog" : undefined} aria-modal={narrow && generationOpen ? true : undefined} tabIndex={-1}>
        <header className="panel-header"><div><span className="eyebrow">SYNTHETIC DATA</span><h2>Generate data</h2></div><button className="icon-button" aria-label="Collapse generation panel" onClick={closeGeneration}>→</button></header>
        <GenerateBar
          seed={seed}
          rows={rows}
          onSeed={setSeed}
          onRows={setRows}
          onGenerate={() => void generate()}
          running={running}
          llm={{
            available: llmState?.ok === true,
            reason: llmState && !llmState.ok ? llmState.reason : undefined,
            provider: llmState?.ok ? llmState.provider : undefined,
            on: llmOn,
            onToggle: setLlmOn,
          }}
          progress={progress}
          onCancel={() => abort.current?.abort()}
        />
        {preview ? <Preview data={preview} /> : <div className="generation-empty"><div className="empty-symbol" aria-hidden="true">▦</div><h3>Your data starts here</h3><p>Press Generate to preview the tables.</p><p className="muted">Keys and relationships follow your schema.</p></div>}
        <footer className="generation-footer"><span className="muted">JSON · CSV · NDJSON</span><button onClick={() => setDialog("export")}>Export…</button></footer>
      </section>
      {dialog === "export" && (
        <ExportDialog
          text={text}
          seed={seed === "" ? undefined : Number(seed)}
          hasLlm={(check?.llmColumns ?? []).length > 0}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
