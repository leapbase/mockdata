import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import { DIALECTS, tableDdl, type Dialect } from "../ddl";
import type { SchemaDiagram } from "../api";

type Table = SchemaDiagram["tables"][number];

export interface MenuState { table: string; x: number; y: number }

/** Right-click menu for a table card. Closes on Escape, outside click, scroll or resize. */
export function TableMenu({ menu, hasData, onShowData, onDdl, onCopyName, onClose }: { menu: MenuState; hasData: boolean; onShowData: () => void; onDdl: (d: Dialect) => void; onCopyName: () => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });
  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    const el = root.current;
    if (el) setPos({ left: Math.max(4, Math.min(menu.x, window.innerWidth - el.offsetWidth - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - el.offsetHeight - 4)) });
    items()[0]?.focus();
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", onClose);
    window.addEventListener("wheel", onClose, { passive: true });
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("resize", onClose); window.removeEventListener("wheel", onClose); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.x, menu.y]);

  function key(e: React.KeyboardEvent) {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  }

  return <div className="context-menu" ref={root} role="menu" aria-label={`Table ${menu.table}`} style={pos} onKeyDown={key} onContextMenu={(e) => e.preventDefault()}>
    <div className="context-menu-title" role="presentation">{menu.table}</div>
    {/* aria-disabled, not disabled: the item stays focusable so keyboard users find it and learn why it is off. */}
    <button role="menuitem" tabIndex={-1} aria-disabled={!hasData} title={hasData ? undefined : "Generate data first"} onClick={() => hasData && onShowData()}>Show data</button>
    <div className="context-menu-sep" role="separator" />
    <div className="context-menu-group" role="presentation">Get DDL</div>
    {DIALECTS.map((d) => <button key={d.id} role="menuitem" tabIndex={-1} onClick={() => onDdl(d.id)}>{d.label}</button>)}
    <div className="context-menu-sep" role="separator" />
    <button role="menuitem" tabIndex={-1} onClick={onCopyName}>Copy table name</button>
  </div>;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
export const copyTableName = copyText;

/** The CREATE TABLE text for one table, with a dialect switch, Copy and Download. */
export function DdlDialog({ table, all, initial, onClose }: { table: Table; all: Table[]; initial: Dialect; onClose: () => void }) {
  const [dialect, setDialect] = useState<Dialect>(initial);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const sql = tableDdl(table, dialect, all);

  function download() {
    const url = URL.createObjectURL(new Blob([sql], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${table.name}.${dialect}.sql`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  return <Modal title={`DDL for ${table.name}`} onClose={onClose}>
    <div className="ddl-bar">
      <label>Dialect <select value={dialect} onChange={(e) => { setDialect(e.target.value as Dialect); setCopied(null); }}>
        {DIALECTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select></label>
      <button onClick={async () => setCopied((await copyText(sql)) ? "yes" : "no")}>Copy</button>
      <button onClick={download}>Download .sql</button>
      <span role="status" className="muted">{copied === "yes" ? "Copied" : copied === "no" ? "Copy failed: select the text instead" : ""}</span>
    </div>
    <pre className="ddl-text" aria-label="DDL">{sql}</pre>
  </Modal>;
}
