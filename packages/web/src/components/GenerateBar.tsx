import type { Progress } from "../api";

export interface GenerateBarProps {
  seed: string;
  rows: string;
  onSeed: (v: string) => void;
  onRows: (v: string) => void;
  onGenerate: () => void;
  running: boolean;
  llm: { available: boolean; reason?: string; provider?: string; on: boolean; onToggle: (v: boolean) => void };
  progress: Progress | null;
  onCancel: () => void;
}

export default function GenerateBar(p: GenerateBarProps) {
  return (
    <div className="generate-bar">
      <label>
        Seed <input type="number" value={p.seed} onChange={(e) => p.onSeed(e.target.value)} placeholder="schema" />
      </label>
      <label>
        Rows per table <input type="number" min={0} value={p.rows} onChange={(e) => p.onRows(e.target.value)} placeholder="schema" />
      </label>
      <label title={p.llm.available ? `Uses ${p.llm.provider}` : p.llm.reason}>
        <input type="checkbox" checked={p.llm.on} disabled={!p.llm.available || p.running} onChange={(e) => p.llm.onToggle(e.target.checked)} /> Fill LLM columns
        {p.llm.available && p.llm.provider && <small> ({p.llm.provider})</small>}
      </label>
      {p.running ? (
        <button onClick={p.onCancel}>Cancel</button>
      ) : (
        <button className="primary" onClick={p.onGenerate}>
          Generate
        </button>
      )}
      {p.progress && (
        <span className="progress" role="status">
          {p.progress.column}: {p.progress.done} / {p.progress.total} · {p.progress.calls} calls · {p.progress.inputTokens + p.progress.outputTokens} tokens
        </span>
      )}
    </div>
  );
}
