import { MarkerType, type Edge, type Node } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import type { ELK, ElkNode, ElkPort } from "elkjs/lib/elk-api.js";
// Only the asset URL: the worker file is fetched by the browser when a Worker is created, never bundled as a chunk.
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { SchemaDiagram as DiagramData } from "./api";

export type TableNode = Node<{ table: DiagramData["tables"][number] }, "table">;
export type DiagramLayout = { nodes: TableNode[]; edges: Edge[] };
/** LR puts referencing tables left of the tables they point at; TB puts them above. */
export type Direction = "LR" | "TB";

export type LayoutEngine = "layered" | "dagre" | "tree" | "force" | "stress" | "grid";
/** Engines in menu order. `directional` engines honour the LR/TB toggle; the others ignore it. */
export const LAYOUT_ENGINES: readonly { id: LayoutEngine; label: string; hint: string; directional: boolean }[] = [
  { id: "layered", label: "Layered", hint: "ELK layers, placed by the columns each reference uses", directional: true },
  { id: "dagre", label: "Layered (basic)", hint: "Dagre: instant, places whole tables only", directional: true },
  { id: "tree", label: "Tree", hint: "ELK tree: each table under the one it references", directional: true },
  { id: "force", label: "Force", hint: "ELK force-directed: related tables pull together", directional: false },
  { id: "stress", label: "Stress", hint: "ELK stress: keeps linked tables at an even distance", directional: false },
  { id: "grid", label: "Grid", hint: "ELK rectangle packing: compact, ignores references", directional: false },
];
export const isLayoutEngine = (v: unknown): v is LayoutEngine => LAYOUT_ENGINES.some((e) => e.id === v);
export const isDirectional = (engine: LayoutEngine) => LAYOUT_ENGINES.find((e) => e.id === engine)!.directional;
type ElkEngine = Exclude<LayoutEngine, "dagre">;

// Must match `.diagram-table` / `.diagram-column` in styles.css: both engines lay out these estimates, not measured cards.
export const CARD_WIDTH = 290;
const HEADER_HEIGHT = 48;
const ROW_HEIGHT = 32;
const NODE_GAP = 60;
const RANK_GAP = 120;
const MARGIN = 40;
const cardHeight = (t: DiagramData["tables"][number]) => HEADER_HEIGHT + t.columns.length * ROW_HEIGHT;

type Link = { id: string; source: string; sourceColumn: string; target: string; targetColumn: string; self: boolean };

/** Every foreign key whose target table and column exist; dangling refs are skipped rather than drawn to nowhere. */
function links(data: DiagramData): Link[] {
  const out: Link[] = [];
  for (const table of data.tables) for (const c of table.columns) {
    if (!c.ref) continue;
    const [target, targetColumn] = c.ref.split(".");
    if (!target || !targetColumn || !data.tables.some((t) => t.name === target && t.columns.some((col) => col.name === targetColumn))) continue;
    out.push({ id: `${table.name}.${c.name}->${c.ref}`, source: table.name, sourceColumn: c.name, target, targetColumn, self: table.name === target });
  }
  return out;
}

function flowEdges(list: Link[]): Edge[] {
  return list.map((l) => ({ id: l.id, source: l.source, sourceHandle: l.sourceColumn, target: l.target, targetHandle: l.self ? `self-${l.targetColumn}` : l.targetColumn, type: "smoothstep", label: l.sourceColumn, style: { stroke: "var(--edge)", strokeWidth: 1.5 }, labelStyle: { fill: "var(--edge)", fontSize: 10 }, labelBgStyle: { fill: "var(--surface)" }, markerEnd: { type: MarkerType.ArrowClosed, color: "var(--edge)" }, ariaLabel: `${l.source}.${l.sourceColumn} references ${l.target}.${l.targetColumn}` }));
}

function flowNodes(data: DiagramData, topLeft: (name: string) => { x: number; y: number }): TableNode[] {
  return data.tables.map((table) => ({ id: table.name, type: "table", data: { table }, position: topLeft(table.name), ariaLabel: `Table ${table.name}, ${table.rows} rows` }));
}

/** Synchronous layout, shown at once and kept if ELK cannot load. Dagre sees tables as boxes and ignores which column an edge uses. */
export function dagreLayout(data: DiagramData, direction: Direction = "LR"): DiagramLayout {
  const graph = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: direction, nodesep: NODE_GAP, ranksep: RANK_GAP, marginx: MARGIN, marginy: MARGIN }).setDefaultEdgeLabel(() => ({}));
  for (const t of data.tables) graph.setNode(t.name, { width: CARD_WIDTH, height: cardHeight(t) });
  const list = links(data);
  for (const l of list) graph.setEdge(l.source, l.target, {}, l.id);
  dagre.layout(graph);
  const heights = new Map(data.tables.map((t) => [t.name, cardHeight(t)]));
  // Dagre reports centres; React Flow wants top-left corners.
  return { edges: flowEdges(list), nodes: flowNodes(data, (name) => { const p = graph.node(name); return { x: p.x - CARD_WIDTH / 2, y: p.y - heights.get(name)! / 2 }; }) };
}

const portId = (table: string, column: string, side: "in" | "out" | "self") => `${table}\u0000${column}\u0000${side}`;

const padding = `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`;
const elkDirection = (direction: Direction) => (direction === "LR" ? "RIGHT" : "DOWN");
// Radial was tried and left out: it overlapped tables on most examples and overflowed the stack on a self reference.
const ELK_OPTIONS: Record<ElkEngine, (direction: Direction) => Record<string, string>> = {
  layered: (direction) => ({
    "elk.algorithm": "layered",
    "elk.direction": elkDirection(direction),
    "elk.spacing.nodeNode": String(NODE_GAP),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(RANK_GAP),
    "elk.spacing.edgeNode": "24",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  }),
  tree: (direction) => ({ "elk.algorithm": "mrtree", "elk.direction": elkDirection(direction), "elk.spacing.nodeNode": String(NODE_GAP) }),
  force: () => ({ "elk.algorithm": "force", "elk.spacing.nodeNode": "80" }),
  stress: () => ({ "elk.algorithm": "stress", "elk.stress.desiredEdgeLength": "400", "elk.spacing.nodeNode": String(NODE_GAP) }),
  grid: () => ({ "elk.algorithm": "rectpacking", "elk.spacing.nodeNode": "40" }),
};
/** Force and stress place centres only and can overlap cards; ELK's SPOrE pass then pushes them apart. */
const needsOverlapRemoval = (engine: ElkEngine) => engine === "force" || engine === "stress";

/**
 * The ELK input graph. For the layered engine each column has fixed ports where its React Flow handles sit (in on the
 * left, out on the right, plus a right-side `self` port for self references), so crossing minimisation sees the real
 * row each edge uses. The other algorithms ignore ports, so their edges join whole tables.
 */
export function elkGraph(data: DiagramData, direction: Direction = "LR", engine: ElkEngine = "layered"): ElkNode {
  const list = links(data);
  const layoutOptions = { ...ELK_OPTIONS[engine](direction), "elk.padding": padding };
  if (engine !== "layered") return {
    id: "root", layoutOptions,
    children: data.tables.map((t) => ({ id: t.name, width: CARD_WIDTH, height: cardHeight(t) })),
    edges: list.map((l) => ({ id: l.id, sources: [l.source], targets: [l.target] })),
  };
  const selfTargets = new Set(list.filter((l) => l.self).map((l) => portId(l.target, l.targetColumn, "self")));
  return {
    id: "root", layoutOptions,
    children: data.tables.map((t) => {
      const ports: ElkPort[] = [];
      t.columns.forEach((c, i) => {
        const y = HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2;
        ports.push({ id: portId(t.name, c.name, "in"), x: 0, y, width: 0, height: 0, layoutOptions: { "elk.port.side": "WEST" } });
        ports.push({ id: portId(t.name, c.name, "out"), x: CARD_WIDTH, y, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } });
        if (selfTargets.has(portId(t.name, c.name, "self"))) ports.push({ id: portId(t.name, c.name, "self"), x: CARD_WIDTH, y, width: 0, height: 0, layoutOptions: { "elk.port.side": "EAST" } });
      });
      return { id: t.name, width: CARD_WIDTH, height: cardHeight(t), ports, layoutOptions: { "elk.portConstraints": "FIXED_POS" } };
    }),
    edges: list.map((l) => ({ id: l.id, sources: [portId(l.source, l.sourceColumn, "out")], targets: [portId(l.target, l.targetColumn, l.self ? "self" : "in")] })),
  };
}

/** Runs one ELK engine. ELK already reports top-left corners. Rejects if ELK fails; the caller keeps the Dagre layout. */
export async function elkLayout(elk: ELK, data: DiagramData, direction: Direction = "LR", engine: ElkEngine = "layered"): Promise<DiagramLayout> {
  let result = await elk.layout(elkGraph(data, direction, engine));
  if (needsOverlapRemoval(engine)) result = await elk.layout({
    id: "root",
    layoutOptions: { "elk.algorithm": "sporeOverlap", "elk.spacing.nodeNode": "40", "elk.padding": padding },
    children: (result.children ?? []).map((n) => ({ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })),
  });
  const at = new Map((result.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  for (const t of data.tables) if (!at.has(t.name)) throw new Error(`ELK returned no position for ${t.name}`);
  return { edges: flowEdges(links(data)), nodes: flowNodes(data, (name) => at.get(name)!) };
}

let shared: Promise<ELK> | null = null;
/**
 * One ELK instance per page, created on first use. The engine (about 1.6 MB) runs in its own worker, fetched as a
 * separate asset only when a diagram is opened, so it is never part of a JavaScript chunk or the main thread.
 */
export function loadElk(): Promise<ELK> {
  shared ??= (async () => {
    if (typeof Worker === "undefined") throw new Error("Web workers are unavailable");
    const { default: Elk } = await import("elkjs/lib/elk-api.js");
    return new Elk({ workerFactory: () => new Worker(elkWorkerUrl) });
  })();
  // A failed load is not cached, so a later diagram can try again.
  shared.catch(() => { shared = null; });
  return shared;
}
