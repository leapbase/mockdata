import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";
import Editor from "./components/Editor";
import GenerateBar from "./components/GenerateBar";
import InferDialog from "./components/InferDialog";
import Preview from "./components/Preview";
import Sidebar from "./components/Sidebar";
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
  const [savedText, setSavedText] = useState("");
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
  const [dialog, setDialog] = useState<"infer" | "export" | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const fail = useCallback((e: unknown) => setError(messageOf(e)), []);

  useEffect(() => {
    api.getFiles().then(setFiles).catch(fail);
    api.getConfig().then(setConfig).catch(fail);
  }, [fail]);

  const debounced = useDebounced(text, debounceMs);
  useEffect(() => {
    let stale = false;
    api
      .validate(debounced)
      .then((r) => !stale && setCheck(r))
      .catch((e) => !stale && fail(e));
    return () => {
      stale = true;
    };
  }, [debounced, fail]);

  const dirty = text !== savedText;

  async function open(p: string) {
    try {
      const t = await api.getFile(p);
      setPath(p);
      setText(t);
      setSavedText(t);
      setWarnings([]);
      setError(null);
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
    if (!llmOn) {
      try {
        setPreview(await api.generate(runBody()));
      } catch (e) {
        fail(e);
      } finally {
        setRunning(false);
      }
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
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

  const errors = check && !check.ok ? (check.errors ?? []) : [];

  return (
    <div className="app">
      {error && (
        <div role="alert" className="banner error">
          {error}
          <button aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      <Sidebar
        files={files}
        active={path}
        dirty={dirty}
        forceNaming={pendingSave}
        onOpen={(p) => void open(p)}
        onCreate={(p) => void saveAs(p, true)}
        onSave={save}
        onInfer={() => setDialog("infer")}
      />
      <main className="editor">
        <Editor value={text} onChange={setText} errors={errors} />
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
      <section className="preview">
        <GenerateBar
          seed={seed}
          rows={rows}
          onSeed={setSeed}
          onRows={setRows}
          onGenerate={() => void generate()}
          running={running}
          llm={{
            available: config?.llm.ok === true,
            reason: config && !config.llm.ok ? config.llm.reason : undefined,
            provider: config?.llm.ok ? config.llm.provider : undefined,
            on: llmOn,
            onToggle: setLlmOn,
          }}
          progress={progress}
          onCancel={() => abort.current?.abort()}
        />
        {preview ? <Preview data={preview} /> : <p className="muted pad">Press Generate to preview the tables.</p>}
      </section>
      {dialog === "infer" && (
        <InferDialog
          dbEnv={config?.dbEnv ?? []}
          onClose={() => setDialog(null)}
          onResult={(r) => {
            setPath(null);
            setText(r.schemaText);
            setSavedText("");
            setPreview(null);
            setWarnings(r.warnings);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
