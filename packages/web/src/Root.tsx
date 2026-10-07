import { lazy, Suspense } from "react";
import AuthGate from "./AuthGate";
import ErrorBoundary from "./components/ErrorBoundary";

const App = lazy(() => import("./App"));
const Landing = lazy(() => import("./landing/Landing"));
const Docs = lazy(() => import("./docs/Docs"));

export const isWorkspacePath = (pathname: string) => pathname === "/app" || pathname === "/app/";
/** Must match the paths the server answers with this page (`isDocsPath` in server/src/static.ts). */
export const isDocsPath = (pathname: string) => /^\/docs(\/[a-z0-9-]+)?\/?$/.test(pathname);

/** Account links sent before the workspace moved to /app pointed at "/#…"; they belong to the workspace. */
export const legacyAuthHash = (hash: string) => /^#(verify_token|reset_token)=/.test(hash);

/** "/" is the landing page, "/app" the workspace and "/docs" the documentation. The server serves this same page for all three. */
function Pages({ location = window.location }: { location?: Pick<Location, "pathname" | "hash" | "replace"> }) {
  if (isWorkspacePath(location.pathname)) {
    return (
      <AuthGate>
        <Suspense fallback={<div className="workspace-empty" role="status">Loading workspace…</div>}>
          <App />
        </Suspense>
      </AuthGate>
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
