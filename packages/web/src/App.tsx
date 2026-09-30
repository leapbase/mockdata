import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import Editor from "./components/Editor";
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

  const errors = check && !check.ok ? (check.errors ?? []) : [];
  void config;

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
        onInfer={() => undefined}
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
      </main>
      <section className="preview" />
    </div>
  );
}
