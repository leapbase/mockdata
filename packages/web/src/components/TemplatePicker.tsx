import { TEMPLATES, type Template } from "../templates";

/** Shown over an empty draft: pick a starter schema, or just type in the editor below. */
export default function TemplatePicker({ onPick, onLibrary }: { onPick: (t: Template) => void; onLibrary?: () => void }) {
  return (
    <section className="template-picker" aria-labelledby="template-picker-title">
      <h2 id="template-picker-title">Start from a template</h2>
      <p className="muted">Or write a schema in the editor below, or import one from a spec or sample files.</p>
      <ul>
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <button type="button" className="template-card" onClick={() => onPick(t)}>
              <strong>{t.title}</strong>
              <span className="muted">{t.blurb}</span>
            </button>
          </li>
        ))}
      </ul>
      {onLibrary && <p><button type="button" onClick={onLibrary}>Browse the library</button></p>}
    </section>
  );
}
