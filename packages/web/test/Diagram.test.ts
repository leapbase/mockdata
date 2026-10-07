import { describe, expect, it } from "vitest";
import Elk from "elkjs/lib/elk.bundled.js";
import { CARD_WIDTH, dagreLayout, elkGraph, elkLayout, type DiagramLayout } from "../src/diagramLayout";
import type { DiagramColumn, SchemaDiagram } from "../src/api";
const id: DiagramColumn = { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false };
const twoTables: SchemaDiagram = { tables: [
  { name: "people", rows: 2, columns: [id] },
  { name: "orders", rows: 4, columns: [id, { ...id, name: "person_id", primaryKey: false, ref: "people.id" }] },
] };
const cyclic: SchemaDiagram = { tables: [
  { name: "a", rows: 2, columns: [id, { ...id, name: "parent", nullable: true, ref: "a.id" }, { ...id, name: "b", nullable: true, ref: "b.id" }] },
  { name: "b", rows: 2, columns: [id, { ...id, name: "a", ref: "a.id" }] },
] };
// The bundled build runs ELK on the calling thread, so the real engine is exercised without a Worker.
const elk = new Elk();
const at = (layout: DiagramLayout, name: string) => layout.nodes.find((n) => n.id === name)!.position;

describe("schema diagram layout (dagre)", () => {
  it("connects references to the correct column handles without overlapping tables", () => {
    const graph = dagreLayout(twoTables);
    expect(graph.edges[0]).toMatchObject({ source: "orders", sourceHandle: "person_id", target: "people", targetHandle: "id" });
    const [a, b] = graph.nodes;
    expect(Math.abs(a!.position.x - b!.position.x)).toBeGreaterThanOrEqual(CARD_WIDTH);
    expect(graph.nodes[1]!.data.table.rows).toBe(4);
  });
  it("lays out self references and cycles with finite positions", () => {
    const graph = dagreLayout(cyclic);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]).toMatchObject({ source: "a", target: "a", sourceHandle: "parent", targetHandle: "self-id" });
    expect(graph.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
  });
  it("stacks related tables vertically top to bottom", () => {
    const graph = dagreLayout(twoTables, "TB");
    expect(at(graph, "people").y).toBeGreaterThan(at(graph, "orders").y);
  });
});

describe("schema diagram layout (ELK)", () => {
  it("puts fixed ports where each column's handles are", () => {
    const graph = elkGraph(cyclic);
    const a = graph.children!.find((n) => n.id === "a")!;
    expect(a.layoutOptions).toMatchObject({ "elk.portConstraints": "FIXED_POS" });
    // Two ports per column, plus the self-reference target on id.
    expect(a.ports).toHaveLength(7);
    const parentIn = a.ports!.find((p) => p.id === "a\u0000parent\u0000in")!;
    const parentOut = a.ports!.find((p) => p.id === "a\u0000parent\u0000out")!;
    expect(parentIn).toMatchObject({ x: 0, y: 48 + 32 + 16 });
    expect(parentOut).toMatchObject({ x: CARD_WIDTH, y: 48 + 32 + 16 });
    expect(graph.edges!.find((e) => e.id === "a.parent->a.id")).toMatchObject({ sources: ["a\u0000parent\u0000out"], targets: ["a\u0000id\u0000self"] });
    expect(graph.layoutOptions!["elk.direction"]).toBe("RIGHT");
    expect(elkGraph(cyclic, "TB").layoutOptions!["elk.direction"]).toBe("DOWN");
  });
  it("lays out tables in the chosen direction with the same edges as dagre", async () => {
    const lr = await elkLayout(elk, twoTables, "LR");
    expect(at(lr, "people").x - at(lr, "orders").x).toBeGreaterThanOrEqual(CARD_WIDTH);
    expect(lr.edges).toEqual(dagreLayout(twoTables).edges);
    const tb = await elkLayout(elk, twoTables, "TB");
    expect(at(tb, "people").y).toBeGreaterThan(at(tb, "orders").y);
  });
  it("handles self references and cycles", async () => {
    const graph = await elkLayout(elk, cyclic);
    expect(graph.edges).toHaveLength(3);
    expect(graph.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
  });
  it("rejects when ELK fails, so the caller keeps the dagre layout", async () => {
    const broken = { layout: () => Promise.reject(new Error("worker died")) } as unknown as Parameters<typeof elkLayout>[0];
    await expect(elkLayout(broken, twoTables)).rejects.toThrow("worker died");
  });
});
