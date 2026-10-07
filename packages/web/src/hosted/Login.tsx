import { useEffect, useState, type FormEvent } from "react";
import { ApiError, messageOf } from "@mockdata/web";
import { forgotPassword, login, register, resendVerification, resetPassword, verifyEmail, type AuthUser, type Me } from "./hostedApi";

type Mode = "login" | "register" | "forgot" | "reset" | "verify" | "checkEmail" | "unverified" | "forgotSent";

/** The same rules the server enforces, so most mistakes are caught before a request. */
const PASSWORD_HINT = "At least 12 characters with an upper-case letter, a lower-case letter, a number and a symbol.";

const NOTICES: Record<string, { text: string; error: boolean }> = {
  "error=google_failed": { text: "Google sign-in did not complete. Try again, or use your email.", error: true },
};

/** Read what the page was opened with (an emailed link, or a return from Google); the effect below then cleans the address bar. */
function readLanding(): { notice?: { text: string; error: boolean }; resetToken?: string; verifyToken?: string } {
  const params = new URLSearchParams(window.location.search);
  // Emailed links carry their one-time token in the fragment, which is never sent to a server or written to a proxy log.
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const key = params.has("error") ? `error=${params.get("error")}` : "";
  return { notice: NOTICES[key], resetToken: fragment.get("reset_token") ?? undefined, verifyToken: fragment.get("verify_token") ?? undefined };
}

export default function Login({ auth, onSignedIn }: { auth: Me["auth"]; onSignedIn: (user: AuthUser) => void }) {
  const [landing] = useState(readLanding);
  const [mode, setMode] = useState<Mode>(landing.resetToken ? "reset" : landing.verifyToken ? "verify" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>(landing.notice && !landing.notice.error ? landing.notice.text : undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The token and any notice are read once; keep neither in the address bar or history.
    if (window.location.search || window.location.hash) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const go = (next: Mode) => {
    setMode(next);
    setError(undefined);
    setNote(undefined);
    setPassword("");
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.code === "email_unverified") go("unverified");
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const submit = (action: () => Promise<void>) => (e: FormEvent) => {
    e.preventDefault();
    void run(action);
  };

  const emailField = (
    <label>
      Email
      <input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
    </label>
  );
  const passwordField = (label: string, hint: boolean, autoComplete: string) => (
    <label>
      {label}
      <input type="password" autoComplete={autoComplete} required minLength={hint ? 12 : 8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
    </label>
  );

  const banner = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      {note && <p role="status" className="note">{note}</p>}
      {!error && !note && landing.notice?.error && mode === "login" && <p role="alert" className="error">{landing.notice.text}</p>}
    </>
  );

  return (
    <main className="login">
      <div className="login-intro">
        <h1>Welcome to mockdata</h1>
        <p>Sign in to design schemas and generate related test data.</p>
      </div>
      {mode === "login" && (
        <form onSubmit={submit(async () => onSignedIn(await login(email, password)))}>
          {banner}
          {emailField}
          {passwordField("Password", false, "current-password")}
          <button type="submit" className="primary" disabled={busy}>Sign in</button>
          {auth.googleConfigured && <a className="button" href="/api/auth/google">Continue with Google</a>}
          <p className="links">
            {auth.emailEnabled && <button type="button" className="link" onClick={() => go("register")}>Create an account</button>}
            {auth.emailEnabled && <button type="button" className="link" onClick={() => go("forgot")}>Forgot password?</button>}
          </p>
        </form>
      )}
      {mode === "register" && (
        <form
          onSubmit={submit(async () => {
            await register(email, password);
            go("checkEmail");
          })}
        >
          <h2>Create an account</h2>
          {banner}
          {emailField}
          {passwordField("Password", true, "new-password")}
          <p className="hint">{PASSWORD_HINT}</p>
          <button type="submit" disabled={busy}>Create account</button>
          {auth.googleConfigured && <a className="button" href="/api/auth/google">Continue with Google</a>}
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </form>
      )}
      {mode === "checkEmail" && (
        <div>
          <h2>Check your email</h2>
          <p role="status">We sent a link to confirm your address. Open it, then sign in.</p>
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </div>
      )}
      {mode === "unverified" && (
        <div>
          <h2>Verify your email</h2>
          <p role="alert" className="error">Verify your email before signing in. Check your inbox for the link.</p>
          {note && <p role="status" className="note">{note}</p>}
          {error && <p role="alert" className="error">{error}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await resendVerification(email);
                setNote("Verification email sent, if the address needs one.");
              })
            }
          >
            Resend verification email
          </button>
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </div>
      )}
      {mode === "forgot" && (
        <form
          onSubmit={submit(async () => {
            await forgotPassword(email);
            go("forgotSent");
          })}
        >
          <h2>Reset your password</h2>
          {banner}
          {emailField}
          <button type="submit" disabled={busy}>Send reset link</button>
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </form>
      )}
      {mode === "forgotSent" && (
        <div>
          <h2>Check your email</h2>
          <p role="status">If that address has an account, we have sent a link to reset the password.</p>
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </div>
      )}
      {mode === "verify" && (
        <form onSubmit={submit(async () => onSignedIn(await verifyEmail(landing.verifyToken!, password)))}>
          <h2>Confirm your email</h2>
          {banner}
          <p className="hint">Enter the password you chose when you signed up to finish.</p>
          {passwordField("Password", false, "current-password")}
          <button type="submit" disabled={busy}>Confirm email</button>
          {auth.emailEnabled && <button type="button" className="link" onClick={() => go("forgot")}>Forgot password?</button>}
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </form>
      )}
      {mode === "reset" && (
        <form onSubmit={submit(async () => onSignedIn(await resetPassword(landing.resetToken!, password)))}>
          <h2>Choose a new password</h2>
          {banner}
          {passwordField("New password", true, "new-password")}
          <p className="hint">{PASSWORD_HINT}</p>
          <button type="submit" disabled={busy}>Set password</button>
          <button type="button" className="link" onClick={() => go("login")}>Back to sign in</button>
        </form>
      )}
      <a className="back-home" href="/">← Back to home</a>
    </main>
  );
}
