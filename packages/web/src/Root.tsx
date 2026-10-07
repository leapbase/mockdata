import { lazy, Suspense, useMemo, type ComponentProps } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import LocalGate from "./components/LocalGate";
import type { Slots } from "./slots";

const App = lazy(() => import("./App"));

export const isWorkspacePath = (pathname: string) => pathname === "/app" || pathname === "/app/";
/** Must match the paths the server answers with this page (`isDocsPath` in server/src/static.ts). */
export const isDocsPath = (pathname: string) => /^\/docs(\/[a-z0-9-]+)?\/?$/.test(pathname);

/** Account links sent before the workspace moved to /app pointed at "/#…"; they belong to the workspace. */
export const legacyAuthHash = (hash: string) => /^#(verify_token|reset_token)=/.test(hash);

/** "/" is the landing page, "/app" the workspace and "/docs" the documentation. The server serves this same page for all three. */
function Pages({ location = window.location, gate: Gate = LocalGate, useLandingCta, landingCopy, docs }: Slots & { location?: Pick<Location, "pathname" | "hash" | "replace"> }) {
  // A hosted shell's copy and docs load beside the page that uses them, so they stay off the startup path and the page never shows open wording first.
  const Landing = useMemo(
    () =>
      lazy(async () => {
        const [{ default: Page }, copy] = await Promise.all([import("./landing/Landing"), landingCopy?.()]);
        return { default: () => <Page useCta={useLandingCta} copy={copy} /> };
      }),
    [landingCopy, useLandingCta],
  );
  const Docs = useMemo(
    () =>
      lazy(async () => {
        const [{ default: Page }, extension] = await Promise.all([import("./docs/Docs"), docs?.()]);
        return { default: (props: Omit<ComponentProps<typeof Page>, "extension">) => <Page {...props} extension={extension} /> };
      }),
    [docs],
  );
  if (isWorkspacePath(location.pathname)) {
    return (
      <Gate>
        <Suspense fallback={<div className="workspace-empty" role="status">Loading workspace…</div>}>
          <App />
        </Suspense>
      </Gate>
    );
  }
  if (isDocsPath(location.pathname)) {
    return (
      <Suspense fallback={null}>
        <Docs location={location} />
      </Suspense>
    );
  }
  if (legacyAuthHash(location.hash)) {
    location.replace(`/app${location.hash}`);
    return null;
  }
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  );
}

/** Every page sits inside one error boundary, so a render error never leaves a blank screen. */
export default function Root(props: Parameters<typeof Pages>[0]) {
  return <ErrorBoundary><Pages {...props} /></ErrorBoundary>;
}
