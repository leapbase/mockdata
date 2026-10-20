import { useState } from "react";
import * as api from "../api";
import { messageOf } from "../hooks";
import Modal from "./Modal";

export interface ExportDialogProps {
  text: string;
  seed: number | undefined;
  hasLlm: boolean;
  /** Only "Download zip": the server does not write exports into a folder. */
  downloadOnly?: boolean;
  onClose: () => void;
}

export default function ExportDialog({ text, seed, hasLlm, downloadOnly = false, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<api.ExportBody["format"]>("json");
  const [outputDir, setOutputDir] = useState("out");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<string[] | null>(null);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const writeFiles = () =>
    guard(async () => {
      const r = await api.exportFiles({ text, seed, format, outputDir, overwrite });
      setWritten(r.files);
    });

  const download = () =>
    guard(async () => {
      const blob = await api.exportZip({ text, seed, format });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mockdata.zip";
      a.click();
      URL.revokeObjectURL(url);
    });

  return (
    <Modal title="Export data" onClose={onClose}>
      {hasLlm && <p className="note">This schema has LLM columns: exporting makes model calls for every row and can take a while.</p>}
      <label className="field">
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value as api.ExportBody["format"])}>
          <option value="json">json</option>
          <option value="ndjson">ndjson</option>
          <option value="csv">csv</option>
        </select>
      </label>
      {!downloadOnly && (
        <>
          <label className="field">
            Folder under the server root
            <input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} />
          </label>
          <label>
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> <span>Overwrite existing files</span>
          </label>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {written && (
        <ul aria-label="Written files">
          {written.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <footer>
        <button className={downloadOnly ? "primary" : undefined} disabled={busy} onClick={() => void download()}>
          Download zip
        </button>
        {!downloadOnly && (
          <button className="primary" disabled={busy || !outputDir.trim()} onClick={() => void writeFiles()}>
            Write files
          </button>
        )}
      </footer>
    </Modal>
  );
}
