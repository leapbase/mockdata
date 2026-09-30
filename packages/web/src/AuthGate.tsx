import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { getMe, setOnUnauthorized, type Me } from "./api";
import Login from "./components/Login";
import UserMenu from "./components/UserMenu";

/** What the page assumes when the server has no accounts (or is too old to say): everything works as it always did. */
const LOCAL: Me = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };

/**
 * Sits around the app. With accounts off it renders the app untouched. With accounts on it shows the sign-in
 * screen until there is a session, and again whenever any call reports the session is gone.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | undefined>();

  const refresh = useCallback(async () => {
    try {
      setMe(await getMe());
    } catch {
      setMe(LOCAL);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const accountsEnabled = me?.auth.accountsEnabled ?? false;
  useEffect(() => {
    if (!accountsEnabled) return;
    setOnUnauthorized(() => void refresh());
    return () => setOnUnauthorized(undefined);
  }, [accountsEnabled, refresh]);

  if (!me) return <p className="login-loading">Loading…</p>;
  if (!me.auth.accountsEnabled) return <>{children}</>;
  if (!me.user) return <Login auth={me.auth} onSignedIn={(user) => setMe({ ...me, user })} />;
  return (
    <>
      <UserMenu user={me.user} onSignedOut={refresh} />
      {/* A new user id remounts the app, so nothing one person had open can show for the next. */}
      <Fragment key={me.user.id}>{children}</Fragment>
    </>
  );
}
