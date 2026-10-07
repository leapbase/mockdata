import { Fragment, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Background, Controls, Handle, Position, ReactFlow, useNodesInitialized, useNodesState, useReactFlow, useStore, type Node, type NodeProps } from "@xyflow/react";
import type { SchemaDiagram as DiagramData } from "../api";
import { LAYOUT_ENGINES, dagreLayout, elkLayout, handleId, isDirectional, isLayoutEngine, loadElk, type DiagramLayout, type Direction, type LayoutEngine, type TableNode } from "../diagramLayout";
import { DdlDialog, TableMenu, copyTableName, type MenuState } from "./DiagramMenu";
import type { Dialect } from "../ddl";
import { useResolvedTheme } from "../theme";
import "@xyflow/react/dist/style.css";

function TableCard({ data }: NodeProps<TableNode>) {
  return <div className="diagram-table">
    <header><strong>{data.table.name}</strong><span>{data.table.rows.toLocaleString()} rows</span></header>
    {data.table.columns.map((c) => <div className="diagram-column" key={c.name}>
      {sides.map(([side, position]) => <Fragment key={side}>
        <Handle type="target" position={position} id={handleId("in", side, c.name)} isConnectable={false} />
        <Handle type="source" position={position} id={handleId("out", side, c.name)} isConnectable={false} />
      </Fragment>)}
      <span className="column-key" title={[c.primaryKey && "Primary key", c.ref && "Foreign key", c.unique && "Unique"].filter(Boolean).join(", ") || "Column"}>{[c.primaryKey && "PK", c.ref && "FK", c.unique && "UQ"].filter(Boolean).join(" ") || "·"}</span>
      <span className="column-name" title={c.name}>{c.name}</span><span className="column-type">{c.type}{c.nullable && "?"}</span>
    </div>)}
  </div>;
}
const sides = [["left", Position.Left], ["right", Position.Right]] as const;
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
const ENGINE_KEY = "mockdata-diagram-layout";
/** Storage can be missing or blocked (private windows), which means the default. */
function stored<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try { const v = localStorage.getItem(key); return valid(v) ? v : fallback; } catch { return fallback; }
}
function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* applied for this page only */ }
}
const isDirection = (v: unknown): v is Direction => v === "LR" || v === "TB";

type Shown = { layout: DiagramLayout; engine: LayoutEngine; failed: boolean };
let warned = false;
/**
 * Dagre's layout is shown at once and is final for the "dagre" engine; any ELK engine replaces it when the worker
 * answers, or leaves it in place (`failed`) if ELK cannot run. A result only applies to the data, engine and direction
 * it was computed for, so a stale answer from a previous edit or choice is ignored.
 */
function useLayout(data: DiagramData, engine: LayoutEngine, direction: Direction): Shown {
  const fallback = useMemo(() => dagreLayout(data, direction), [data, direction]);
  const [elk, setElk] = useState<{ data: DiagramData; engine: LayoutEngine; direction: Direction; layout: DiagramLayout | null } | null>(null);
  useEffect(() => {
    if (engine === "dagre") return;
    let live = true;
    loadElk().then((elk) => elkLayout(elk, data, direction, engine)).then(
      (layout) => { if (live) setElk({ data, engine, direction, layout }); },
      (e: unknown) => {
        if (!warned) { warned = true; console.warn("Diagram: ELK layout unavailable, using the basic layout", e); }
        if (live) setElk({ data, engine, direction, layout: null });
      },
    );
    return () => { live = false; };
  }, [data, engine, direction]);
  const current = elk && elk.data === data && elk.engine === engine && elk.direction === direction ? elk : null;
  if (engine !== "dagre" && current?.layout) return { layout: current.layout, engine, failed: false };
  return { layout: fallback, engine: "dagre", failed: engine !== "dagre" && !!current };
}

/**
 * `dataTables`: tables that have generated rows in the current preview (enables "Show data").
 * `embedded` (the landing page): the default layout whatever the visitor chose in the workspace, no toolbar, legend or
 * table menu, and the mouse wheel scrolls the page instead of zooming the diagram.
 */
export default function SchemaDiagram({ data, dataTables = [], onShowData, embedded = false }: { data: DiagramData; dataTables?: string[]; onShowData?: (table: string) => void; embedded?: boolean }) {
  const [direction, setDirection] = useState<Direction>(() => (embedded ? "LR" : stored(DIRECTION_KEY, isDirection, "LR")));
  const [chosen, setChosen] = useState<LayoutEngine>(() => (embedded ? "layered" : stored(ENGINE_KEY, isLayoutEngine, "layered")));
  const { layout: { nodes: layoutNodes, edges }, engine: shown, failed } = useLayout(data, chosen, direction);
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
    if (embedded || (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10"))) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
    if (!card?.dataset.id) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    setMenu({ table: card.dataset.id, x: r.left + 16, y: r.top + 24 });
  }

  function chooseDirection(next: Direction) {
    setDirection(next);
    save(DIRECTION_KEY, next);
    setMenu(null);
  }
  function chooseEngine(next: LayoutEngine) {
    setChosen(next);
    save(ENGINE_KEY, next);
    setMenu(null);
  }
  const directional = isDirectional(chosen);

  return <div className="diagram-canvas" aria-label="Schema relationship diagram" data-layout-engine={shown} onKeyDown={onKeyDown}>
    <ReactFlow colorMode={theme} nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable fitView minZoom={0.1} maxZoom={2} fitViewOptions={fitOptions} proOptions={{ hideAttribution: true }}
      zoomOnScroll={!embedded} preventScrolling={!embedded}
      onNodeContextMenu={embedded ? undefined : (e: ReactMouseEvent, node: Node) => { e.preventDefault(); setMenu({ table: node.id, x: e.clientX, y: e.clientY }); }}
      onPaneContextMenu={(e: ReactMouseEvent | MouseEvent) => { e.preventDefault(); setMenu(null); }}
      onPaneClick={() => setMenu(null)} onNodeClick={() => setMenu(null)} onMoveStart={(e: MouseEvent | TouchEvent | null) => { if (e) setMenu(null); }}>
      <FitViewport nodes={layoutNodes} />
      <Background color="var(--grid-dot)" gap={22} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
    {!embedded && <><div className="diagram-toolbar">
      <label className="diagram-engine">Layout
        <select value={chosen} onChange={(e) => chooseEngine(e.target.value as LayoutEngine)} title={LAYOUT_ENGINES.find((e) => e.id === chosen)!.hint}>
          {LAYOUT_ENGINES.map((e) => <option key={e.id} value={e.id} title={e.hint}>{e.label}</option>)}
        </select>
      </label>
      <div className="diagram-direction" role="group" aria-label="Layout direction" title={directional ? undefined : "This layout has no direction"}>
        {([["LR", "Left to right"], ["TB", "Top to bottom"]] as const).map(([value, label]) =>
          <button key={value} type="button" disabled={!directional} aria-pressed={directional && direction === value} onClick={() => chooseDirection(value)}>{label}</button>)}
      </div>
      {failed && <span className="diagram-layout-note" role="status">Layout engine unavailable; showing the basic layout</span>}
    </div>
    <div className="diagram-legend">PK Primary key <span>FK Foreign key</span><span>UQ Unique</span><span>? Nullable</span><span>Right-click a table for DDL</span></div></>}
    {menu && <TableMenu menu={menu} hasData={!!onShowData && dataTables.includes(menu.table)} onShowData={() => { onShowData?.(menu.table); setMenu(null); }} onClose={() => setMenu(null)}
      onDdl={(dialect) => { setDdl({ table: menu.table, dialect }); setMenu(null); }}
      onCopyName={() => { void copyTableName(menu.table); setMenu(null); }} />}
    {ddl && ddlTable && <DdlDialog table={ddlTable} all={data.tables} initial={ddl.dialect} onClose={() => setDdl(null)} />}
  </div>;
}
