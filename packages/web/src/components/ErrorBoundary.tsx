import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A render error anywhere in a page shows this instead of a blank screen. The detail goes to the console only;
 * the page shows nothing from the error, since it can contain schema text or server messages.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("mockdata: the page failed to render", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="workspace-empty error-boundary" role="alert">
      <h1>Something went wrong</h1>
      <p>This page hit an unexpected error. Your saved schemas are not affected.</p>
      <p><button type="button" onClick={() => window.location.reload()}>Reload the page</button> <a className="button" href="/">Go to the home page</a></p>
    </main>;
  }
}
