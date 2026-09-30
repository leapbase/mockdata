import { useEffect, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  errors: { message: string; line?: number }[];
}

const dark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

export default function Editor({ value, onChange, errors }: EditorProps) {
  const view = useRef<EditorView | null>(null);

  // Show the server's validation errors as inline markers (line 1 when the error has no line).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const diagnostics: Diagnostic[] = errors.map((e) => {
      const line = v.state.doc.line(Math.min(Math.max(e.line ?? 1, 1), v.state.doc.lines));
      return { from: line.from, to: line.to, severity: "error", message: e.message };
    });
    v.dispatch(setDiagnostics(v.state, diagnostics));
  }, [errors]);

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={dark ? "dark" : "light"}
      extensions={[yaml()]}
      onChange={onChange}
      onCreateEditor={(v: EditorView) => {
        view.current = v;
      }}
      basicSetup={{ lineNumbers: true, foldGutter: false }}
    />
  );
}
