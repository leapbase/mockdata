import { useEffect, useState } from "react";

export interface SidebarProps {
  files: string[];
  active: string | null;
  dirty: boolean;
  /** Ask for a file name (a draft with no path is being saved). */
  forceNaming?: boolean;
  onOpen: (path: string) => void;
  onCreate: (path: string) => void;
  onSave: () => void;
  onInfer: () => void;
  onExport?: () => void;
}

/** "orders" -> "orders.yaml"; names that already end in .yaml/.yml/.json are kept. */
export const withExtension = (name: string) => (/\.(ya?ml|json)$/i.test(name) ? name : `${name}.yaml`);

export default function Sidebar({ files, active, dirty, forceNaming, onOpen, onCreate, onSave, onInfer, onExport }: SidebarProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (forceNaming) setNaming(true);
  }, [forceNaming]);

  return (
    <aside className="sidebar">
      <div className="toolbar">
        <button onClick={() => setNaming(true)}>New</button>
        <button onClick={onSave} disabled={!dirty && active !== null}>
          Save
        </button>
        <button onClick={onInfer}>Infer from source…</button>
        {onExport && <button onClick={onExport}>Export…</button>}
      </div>
      {naming && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onCreate(withExtension(name.trim()));
            setName("");
            setNaming(false);
          }}
        >
          <input autoFocus aria-label="New file name" placeholder="name.yaml" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(false)} />
        </form>
      )}
      <ul className="files">
        {files.map((f) => (
          <li key={f}>
            <button className={f === active ? "file active" : "file"} onClick={() => onOpen(f)}>
              {f}
            </button>
            {f === active && dirty && <span className="dot">unsaved</span>}
          </li>
        ))}
      </ul>
      {active === null && dirty && <p className="hint">Draft not saved yet: press Save to name it.</p>}
    </aside>
  );
}
