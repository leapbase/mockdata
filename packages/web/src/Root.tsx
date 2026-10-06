import { lazy, Suspense } from "react";
import AuthGate from "./AuthGate";

const App = lazy(() => import("./App"));
const Landing = lazy(() => import("./landing/Landing"));

export const isWorkspacePath = (pathname: string) => pathname === "/app" || pathname === "/app/";

/** Account links sent before the workspace moved to /app pointed at "/#…"; they belong to the workspace. */
export const legacyAuthHash = (hash: string) => /^#(verify_token|reset_token)=/.test(hash);

/** "/" is the landing page and "/app" the workspace. The server serves this same page for both. */
export default function Root({ location = window.location }: { location?: Pick<Location, "pathname" | "hash" | "replace"> }) {
  if (isWorkspacePath(location.pathname)) {
    return (
      <AuthGate>
        <Suspense fallback={<div className="workspace-empty" role="status">Loading workspace…</div>}>
          <App />
        </Suspense>
      </AuthGate>
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
