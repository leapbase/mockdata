import { useState, type FormEvent } from "react";
import { changePassword, logout, logoutAll, type AuthUser } from "../api";
import { messageOf } from "../hooks";
import Modal from "./Modal";

/** Who is signed in, with sign-out and change-password. Floats at the bottom of the file list. */
export default function UserMenu({ user, onSignedOut }: { user: AuthUser; onSignedOut: () => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setError(undefined);
    setDone(false);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-chip">
      <span title={user.email ?? undefined}>{user.email ?? user.displayName}</span>
      <button onClick={() => setOpen(true)}>Change password</button>
      <button
        onClick={() =>
          void logout()
            .catch(() => undefined)
            .then(onSignedOut)
        }
      >
        Sign out
      </button>
      <button
        onClick={() =>
          void logoutAll()
            .catch(() => undefined)
            .then(onSignedOut)
        }
      >
        Sign out everywhere
      </button>
      {open && (
        <Modal title="Change password" onClose={close}>
          <form onSubmit={submit} className="stack">
            {error && <p role="alert" className="error">{error}</p>}
            {done && <p role="status" className="note">Password changed. Your other sessions were signed out.</p>}
            <label>
              Current password
              <input type="password" autoComplete="current-password" required maxLength={128} value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label>
              New password
              <input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} />
            </label>
            <p className="hint">At least 12 characters with an upper-case letter, a lower-case letter, a number and a symbol.</p>
            <footer>
              <button type="submit" disabled={busy}>Change password</button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
