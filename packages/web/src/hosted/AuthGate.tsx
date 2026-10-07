import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Header, setOnUnauthorized, type Cta, type LandingCopy, type Locale } from "@mockdata/web";
import { getMe, type Me } from "./hostedApi";
import { SIGN_IN } from "./labels";
import Login from "./Login";
import UserMenu from "./UserMenu";

/** What the page assumes when the server has no accounts (or is too old to say): everything works as it always did. */
const LOCAL: Me = { user: null, auth: { accountsEnabled: false, googleConfigured: false, emailEnabled: false } };

/** Landing-page labels when accounts are on: a signed-out visitor is asked to sign in, everyone else goes straight in. */
export function useAccountCta(t: LandingCopy, locale: Locale): Cta {
  const [me, setMe] = useState<Me | undefined>();
  useEffect(() => {
    let live = true;
    getMe().then((m) => live && setMe(m), () => undefined);
    return () => {
      live = false;
    };
  }, []);
  const signedOut = me?.auth.accountsEnabled && !me.user;
  return signedOut ? SIGN_IN[locale] : { primary: t.cta.openWorkspace, nav: t.cta.openWorkspace };
}

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

  if (!me) return <div className="site-shell"><Header><span className="workspace-label">Loading…</span></Header><p className="login-loading">Loading…</p></div>;
  if (!me.auth.accountsEnabled) return <div className="site-shell"><Header><span className="workspace-label"><i />Local workspace</span></Header>{children}</div>;
  if (!me.user) return <div className="site-shell"><Header><span className="workspace-label">Sign in to your workspace</span></Header><div className="auth-screen"><Login auth={me.auth} onSignedIn={(user) => setMe({ ...me, user })} /></div></div>;
  return (
    <div className="site-shell">
      <Header><UserMenu user={me.user} onSignedOut={refresh} /></Header>
      {/* A new user id remounts the app, so nothing one person had open can show for the next. */}
      <Fragment key={me.user.id}>{children}</Fragment>
    </div>
  );
}
