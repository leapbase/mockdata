import { useEffect, useState, type FormEvent } from "react";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyInfo } from "./hostedApi";
import { Modal, copyText, messageOf } from "@mockdata/web";

const when = (epoch: number | null) => (epoch === null ? "never" : new Date(epoch * 1000).toLocaleString());

/** Make, list and revoke the keys MCP clients use for this server's /mcp. A new key is shown once, here, and never again. */
export default function ApiKeys({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<ApiKeyInfo[] | undefined>();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const endpoint = `${window.location.origin}/mcp`;
  const command = `claude mcp add --transport http mockdata ${endpoint} --header "Authorization: Bearer ${fresh ?? "<your API key>"}"`;

  useEffect(() => {
    listApiKeys().then(setKeys, (e) => setError(messageOf(e)));
  }, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      const made = await createApiKey(name);
      setFresh(made.key);
      setName("");
      setKeys((k) => [...(k ?? []), made.info]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key: ApiKeyInfo) {
    setError(undefined);
    try {
      await revokeApiKey(key.id);
      setKeys((k) => k?.filter((x) => x.id !== key.id));
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <Modal title="API keys" onClose={onClose}>
      <div className="stack api-keys">
        <p className="muted">
          Keys let MCP clients such as Claude Code or Cursor use your workspace at <code>{endpoint}</code>. They can read and write your schemas and spend your daily model allowance, so treat them like passwords.
        </p>
        {error && <p role="alert" className="error">{error}</p>}
        {fresh && (
          <div className="new-key" role="status">
            <strong>Copy this key now. It will not be shown again.</strong>
            <code className="secret">{fresh}</code>
            <div className="row">
              <button type="button" onClick={() => void copyText(fresh).then(setCopied)}>{copied ? "Copied" : "Copy key"}</button>
            </div>
          </div>
        )}
        <form onSubmit={create} className="key-form">
          <label>
            New key name
            <input value={name} maxLength={64} placeholder="e.g. laptop" onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="primary" disabled={busy}>Create key</button>
        </form>
        {keys === undefined ? (
          <p className="muted">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="muted">No keys yet.</p>
        ) : (
          <ul className="key-list" aria-label="Your API keys">
            {keys.map((k) => (
              <li key={k.id}>
                <div>
                  <strong>{k.name}</strong> <code>{k.prefix}…</code>
                  <span className="muted">Created {when(k.createdAt)} · last used {when(k.lastUsedAt)}</span>
                </div>
                <button type="button" onClick={() => void revoke(k)} aria-label={`Revoke ${k.name}`}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <p className="muted">Connect Claude Code:</p>
          <pre className="ddl-text">{command}</pre>
        </div>
      </div>
    </Modal>
  );
}
