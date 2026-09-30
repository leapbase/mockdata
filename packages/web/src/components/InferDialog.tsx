import { useState } from "react";
import * as api from "../api";
import { messageOf } from "../hooks";
import Modal from "./Modal";

type Source = "File" | "Paste" | "Database";

export default function InferDialog({ dbEnv, onResult, onClose }: { dbEnv: string[]; onResult: (r: api.InferResult) => void; onClose: () => void }) {
  const [source, setSource] = useState<Source>("File");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [chosenEnv, setChosenEnv] = useState<string | null>(null);
  // The config may arrive after the dialog opens, so the default is derived, not captured at mount.
  const envName = chosenEnv ?? dbEnv[0] ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const body: api.InferBody | null =
    source === "File"
      ? path.trim()
        ? { path: path.trim() }
        : null
      : source === "Paste"
        ? content.trim()
          ? { content, ...(name.trim() ? { name: name.trim() } : {}) }
          : null
        : envName
          ? { connectionEnv: envName }
          : null;

  async function run() {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      onResult(await api.infer(body));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Infer a schema from a source" onClose={onClose}>
      <div className="tabs" role="tablist">
        {(["File", "Paste", "Database"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={s === source} className={s === source ? "tab active" : "tab"} onClick={() => setSource(s)}>
            {s}
          </button>
        ))}
      </div>
      {source === "File" && (
        <label className="field">
          Path under the folder
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="data/orders.csv, api.yaml, shop.db, samples/" />
        </label>
      )}
      {source === "Paste" && (
        <>
          <label className="field">
            File name (sets the format and table name)
            <input aria-label="File name" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders.csv" />
          </label>
          <label className="field">
            Sample or schema text
            <textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
        </>
      )}
      {source === "Database" &&
        (dbEnv.length > 0 ? (
          <label className="field">
            Database variable
            <select aria-label="Database variable" value={envName} onChange={(e) => setChosenEnv(e.target.value)}>
              {dbEnv.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <small className="muted">Only catalog metadata is read, never rows. The connection string stays on the server.</small>
          </label>
        ) : (
          <p className="muted">
            No database variable found. Put a URL in the server’s environment or its folder’s .env, for example <code>DATABASE_URL=postgres://…</code>, then reload.
          </p>
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button className="primary" disabled={!body || busy} onClick={() => void run()}>
          Infer
        </button>
      </footer>
    </Modal>
  );
}
