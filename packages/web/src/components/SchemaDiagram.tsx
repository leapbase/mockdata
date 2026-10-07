import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Background, Controls, Handle, Position, ReactFlow, useNodesInitialized, useNodesState, useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import type { SchemaDiagram as DiagramData } from "../api";
import { dagreLayout, elkLayout, loadElk, type DiagramLayout, type Direction, type TableNode } from "../diagramLayout";
import { DdlDialog, TableMenu, copyTableName, type MenuState } from "./DiagramMenu";
import type { Dialect } from "../ddl";
import { useResolvedTheme } from "../theme";
import "@xyflow/react/dist/style.css";

function TableCard({ data }: NodeProps<TableNode>) {
  const selfTargets = new Set(data.table.columns.filter((c) => c.ref?.split(".")[0] === data.table.name).map((c) => c.ref!.split(".")[1]));
  return <div className="diagram-table">
    <header><strong>{data.table.name}</strong><span>{data.table.rows.toLocaleString()} rows</span></header>
    {data.table.columns.map((c) => <div className="diagram-column" key={c.name}>
      <Handle type="target" position={Position.Left} id={c.name} isConnectable={false} />
      {selfTargets.has(c.name) && <Handle type="target" position={Position.Right} id={`self-${c.name}`} isConnectable={false} />}
      <span className="column-key" title={[c.primaryKey && "Primary key", c.ref && "Foreign key", c.unique && "Unique"].filter(Boolean).join(", ") || "Column"}>{[c.primaryKey && "PK", c.ref && "FK", c.unique && "UQ"].filter(Boolean).join(" ") || "·"}</span>
      <span className="column-name" title={c.name}>{c.name}</span><span className="column-type">{c.type}{c.nullable && "?"}</span>
      <Handle type="source" position={Position.Right} id={c.name} isConnectable={false} />
    </div>)}
  </div>;
}
const nodeTypes = { table: TableCard };
const fitOptions = { padding: 0.15, maxZoom: 1 };

/** Reframe on layout changes, not on user pan/zoom. React Flow owns size observation. */
function FitViewport({ nodes }: { nodes: TableNode[] }) {
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (!initialized || !width || !height) return;
    const timer = window.setTimeout(() => void fitView(fitOptions), 80);
    return () => window.clearTimeout(timer);
  }, [initialized, width, height, nodes, fitView]);
  return null;
}

const DIRECTION_KEY = "mockdata-diagram-direction";
/** Storage can be missing or blocked (private windows), which means the default. */
function storedDirection(): Direction {
  try { return localStorage.getItem(DIRECTION_KEY) === "TB" ? "TB" : "LR"; } catch { return "LR"; }
}
function saveDirection(direction: Direction): void {
  try { localStorage.setItem(DIRECTION_KEY, direction); } catch { /* applied for this page only */ }
}

let warned = false;
/**
 * Dagre's layout is shown at once; ELK's port-aware layout replaces it when the worker answers. A result only applies
 * to the data and direction it was computed for, so a stale answer from a previous edit is ignored.
 */
function useLayout(data: DiagramData, direction: Direction): { layout: DiagramLayout; engine: "dagre" | "elk" } {
  const fallback = useMemo(() => dagreLayout(data, direction), [data, direction]);
  const [elk, setElk] = useState<{ data: DiagramData; direction: Direction; layout: DiagramLayout } | null>(null);
  useEffect(() => {
    let live = true;
    loadElk().then((engine) => elkLayout(engine, data, direction)).then(
      (layout) => { if (live) setElk({ data, direction, layout }); },
      (e: unknown) => { if (!warned) { warned = true; console.warn("Diagram: ELK layout unavailable, using the basic layout", e); } },
    );
    return () => { live = false; };
  }, [data, direction]);
  return elk && elk.data === data && elk.direction === direction ? { layout: elk.layout, engine: "elk" } : { layout: fallback, engine: "dagre" };
}

/** `dataTables`: tables that have generated rows in the current preview (enables "Show data"). */
export default function SchemaDiagram({ data, dataTables = [], onShowData }: { data: DiagramData; dataTables?: string[]; onShowData?: (table: string) => void }) {
  const [direction, setDirection] = useState<Direction>(storedDirection);
  const { layout: { nodes: layoutNodes, edges }, engine } = useLayout(data, direction);
  const theme = useResolvedTheme();
  // Controlled nodes must retain React Flow's measured dimensions before fitting.
  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  useEffect(() => setNodes(layoutNodes), [layoutNodes, setNodes]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [ddl, setDdl] = useState<{ table: string; dialect: Dialect } | null>(null);
  // A re-validated schema may drop the table a menu or dialog was opened for.
  const ddlTable = ddl && data.tables.find((t) => t.name === ddl.table);
  useEffect(() => { if (menu && !data.tables.some((t) => t.name === menu.table)) setMenu(null); }, [data, menu]);
  if (!nodes.length) return <div className="workspace-empty"><h2>No tables yet</h2><p>Add tables in the editor to see their relationships.</p></div>;

  /** Shift+F10 / the context-menu key opens the menu for the focused table, like a right-click. */
  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    if (!card?.dataset.id) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    setMenu({ table: card.dataset.id, x: r.left + 16, y: r.top + 24 });
  }

  function chooseDirection(next: Direction) {
    setDirection(next);
    saveDirection(next);
    setMenu(null);
  }

  return <div className="diagram-canvas" aria-label="Schema relationship diagram" data-layout-engine={engine} onKeyDown={onKeyDown}>
    <ReactFlow colorMode={theme} nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable fitView minZoom={0.1} maxZoom={2} fitViewOptions={fitOptions} proOptions={{ hideAttribution: true }}
      onNodeContextMenu={(e: ReactMouseEvent, node: Node) => { e.preventDefault(); setMenu({ table: node.id, x: e.clientX, y: e.clientY }); }}
      onPaneContextMenu={(e: ReactMouseEvent | MouseEvent) => { e.preventDefault(); setMenu(null); }}
      onPaneClick={() => setMenu(null)} onNodeClick={() => setMenu(null)} onMoveStart={(e: MouseEvent | TouchEvent | null) => { if (e) setMenu(null); }}>
      <FitViewport nodes={layoutNodes} />
      <Background color="var(--grid-dot)" gap={22} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
    <div className="diagram-direction" role="group" aria-label="Layout direction">
      {([["LR", "Left to right"], ["TB", "Top to bottom"]] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={direction === value} onClick={() => chooseDirection(value)}>{label}</button>)}
    </div>
    <div className="diagram-legend">PK Primary key <span>FK Foreign key</span><span>UQ Unique</span><span>? Nullable</span><span>Right-click a table for DDL</span></div>
    {menu && <TableMenu menu={menu} hasData={!!onShowData && dataTables.includes(menu.table)} onShowData={() => { onShowData?.(menu.table); setMenu(null); }} onClose={() => setMenu(null)}
      onDdl={(dialect) => { setDdl({ table: menu.table, dialect }); setMenu(null); }}
      onCopyName={() => { void copyTableName(menu.table); setMenu(null); }} />}
    {ddl && ddlTable && <DdlDialog table={ddlTable} all={data.tables} initial={ddl.dialect} onClose={() => setDdl(null)} />}
  </div>;
}
