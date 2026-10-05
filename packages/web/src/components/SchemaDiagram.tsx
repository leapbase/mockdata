import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useNodesInitialized, useNodesState, useReactFlow, useStore, type Node, type NodeProps, type Edge } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import type { SchemaDiagram as DiagramData } from "../api";
import { DdlDialog, TableMenu, copyTableName, type MenuState } from "./DiagramMenu";
import type { Dialect } from "../ddl";
import "@xyflow/react/dist/style.css";

type TableNode = Node<{ table: DiagramData["tables"][number] }, "table">;
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

export function diagramGraph(data: DiagramData): { nodes: TableNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: "LR", nodesep: 60, ranksep: 120, marginx: 40, marginy: 40 }).setDefaultEdgeLabel(() => ({}));
  for (const t of data.tables) graph.setNode(t.name, { width: 290, height: 48 + t.columns.length * 32 });
  const edges: Edge[] = [];
  for (const table of data.tables) for (const c of table.columns) {
    if (!c.ref) continue;
    const [target, targetHandle] = c.ref.split(".");
    if (!target || !targetHandle || !data.tables.some((t) => t.name === target && t.columns.some((col) => col.name === targetHandle))) continue;
    const id = `${table.name}.${c.name}->${c.ref}`;
    graph.setEdge(table.name, target, {}, id);
    edges.push({ id, source: table.name, sourceHandle: c.name, target, targetHandle: table.name === target ? `self-${targetHandle}` : targetHandle, type: "smoothstep", label: c.name, style: { stroke: "#0a776f", strokeWidth: 1.5 }, labelStyle: { fill: "#0a776f", fontSize: 10 }, labelBgStyle: { fill: "#ffffff" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#0a776f" }, ariaLabel: `${table.name}.${c.name} references ${c.ref}` });
  }
  dagre.layout(graph);
  return { edges, nodes: data.tables.map((table) => {
    const pos = graph.node(table.name);
    return { id: table.name, type: "table", data: { table }, position: { x: pos.x - 145, y: pos.y - (48 + table.columns.length * 32) / 2 }, ariaLabel: `Table ${table.name}, ${table.rows} rows` };
  }) };
}

/** `dataTables`: tables that have generated rows in the current preview (enables "Show data"). */
export default function SchemaDiagram({ data, dataTables = [], onShowData }: { data: DiagramData; dataTables?: string[]; onShowData?: (table: string) => void }) {
  const { nodes: layoutNodes, edges } = useMemo(() => diagramGraph(data), [data]);
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

  return <div className="diagram-canvas" aria-label="Schema relationship diagram" onKeyDown={onKeyDown}>
    <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable fitView minZoom={0.1} maxZoom={2} fitViewOptions={fitOptions} proOptions={{ hideAttribution: true }}
      onNodeContextMenu={(e: ReactMouseEvent, node: Node) => { e.preventDefault(); setMenu({ table: node.id, x: e.clientX, y: e.clientY }); }}
      onPaneContextMenu={(e: ReactMouseEvent | MouseEvent) => { e.preventDefault(); setMenu(null); }}
      onPaneClick={() => setMenu(null)} onNodeClick={() => setMenu(null)} onMoveStart={(e: MouseEvent | TouchEvent | null) => { if (e) setMenu(null); }}>
      <FitViewport nodes={layoutNodes} />
      <Background color="#d8d3c9" gap={22} size={1} /><Controls showInteractive={false} />
    </ReactFlow>
    <div className="diagram-legend">PK Primary key <span>FK Foreign key</span><span>UQ Unique</span><span>? Nullable</span><span>Right-click a table for DDL</span></div>
    {menu && <TableMenu menu={menu} hasData={!!onShowData && dataTables.includes(menu.table)} onShowData={() => { onShowData?.(menu.table); setMenu(null); }} onClose={() => setMenu(null)}
      onDdl={(dialect) => { setDdl({ table: menu.table, dialect }); setMenu(null); }}
      onCopyName={() => { void copyTableName(menu.table); setMenu(null); }} />}
    {ddl && ddlTable && <DdlDialog table={ddlTable} all={data.tables} initial={ddl.dialect} onClose={() => setDdl(null)} />}
  </div>;
}
