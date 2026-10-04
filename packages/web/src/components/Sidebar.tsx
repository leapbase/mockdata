import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { navigateTabs } from "../tabs";

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
  tab?: "schemas" | "import";
  onTab?: (tab: "schemas" | "import") => void;
  importContent?: ReactNode;
}

/** "orders" -> "orders.yaml"; names that already end in .yaml/.yml/.json are kept. */
export const withExtension = (name: string) => (/\.(ya?ml|json)$/i.test(name) ? name : `${name}.yaml`);

export default function Sidebar({ files, active, dirty, forceNaming, onOpen, onCreate, onSave, onInfer, onExport, tab = "schemas", onTab, importContent }: SidebarProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (forceNaming) setNaming(true);
  }, [forceNaming]);

  return (
    <div className="sidebar-content">
      {onTab && <div className="sidebar-tabs" role="tablist" aria-label="Workspace navigation" onKeyDown={navigateTabs}>
        <button role="tab" id="schemas-tab" aria-controls="schemas-content" tabIndex={tab === "schemas" ? 0 : -1} aria-selected={tab === "schemas"} onClick={() => onTab("schemas")}>Schemas</button>
        <button role="tab" id="import-tab" aria-controls="import-content" tabIndex={tab === "import" ? 0 : -1} aria-selected={tab === "import"} onClick={() => onTab("import")}>Import</button>
      </div>}
      <div id="import-content" role={onTab ? "tabpanel" : undefined} aria-labelledby={onTab ? "import-tab" : undefined} hidden={tab !== "import"}>{importContent}</div>
      <div id="schemas-content" role={onTab ? "tabpanel" : undefined} aria-labelledby={onTab ? "schemas-tab" : undefined} hidden={tab !== "schemas"} className="schema-list-panel">
      <div className="toolbar">
        <button onClick={() => setNaming(true)}>New</button>
        <button onClick={onSave} disabled={!dirty && active !== null}>
          Save
        </button>
        {!onTab && <button onClick={onInfer}>Infer from source…</button>}
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
      {files.length === 0 && <p className="empty-files muted">No saved schemas yet. Create one or import a source.</p>}
      {active === null && dirty && <p className="hint">Draft not saved yet: press Save to name it.</p>}
      <div className="sidebar-footer">{files.length} saved schema{files.length === 1 ? "" : "s"}<span>YAML / JSON</span></div>
      </div>
    </div>
  );
}
