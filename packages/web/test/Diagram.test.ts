import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Elk from "elkjs/lib/elk.bundled.js";
import { parse } from "yaml";
import { parseSchema } from "@mockdata/core";
import { DIAGRAM, DIAGRAM_EXAMPLE } from "../src/landing/diagram";
import { CARD_WIDTH, LAYOUT_ENGINES, dagreLayout, edgeSides, elkGraph, elkLayout, type DiagramLayout, type LayoutEngine } from "../src/diagramLayout";
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
    expect(graph.edges[0]).toMatchObject({ source: "orders", sourceHandle: "out-right:person_id", target: "people", targetHandle: "in-left:id" });
    const [a, b] = graph.nodes;
    expect(Math.abs(a!.position.x - b!.position.x)).toBeGreaterThanOrEqual(CARD_WIDTH);
    expect(graph.nodes[1]!.data.table.rows).toBe(4);
  });
  it("lays out self references and cycles with finite positions", () => {
    const graph = dagreLayout(cyclic);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]).toMatchObject({ source: "a", target: "a", sourceHandle: "out-right:parent", targetHandle: "in-right:id" });
    expect(graph.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
  });
  it("stacks related tables vertically top to bottom", () => {
    const graph = dagreLayout(twoTables, "TB");
    expect(at(graph, "people").y).toBeGreaterThan(at(graph, "orders").y);
  });
});

describe("edge sides", () => {
  it("faces the cards toward each other, or loops on one side when they are stacked", () => {
    expect(edgeSides({ x: 0 }, { x: CARD_WIDTH + 10 })).toEqual(["right", "left"]);
    expect(edgeSides({ x: CARD_WIDTH + 10 }, { x: 0 })).toEqual(["left", "right"]);
    expect(edgeSides({ x: 100 }, { x: 40 })).toEqual(["left", "left"]);
    expect(edgeSides({ x: 100 }, { x: 100 })).toEqual(["right", "right"]);
    expect(edgeSides({ x: 0 }, { x: 999 }, true)).toEqual(["right", "right"]);
  });
  it("follows the layout: top-to-bottom stacks loop instead of crossing the card", () => {
    const lr = dagreLayout(twoTables, "LR").edges[0]!;
    expect([lr.sourceHandle, lr.targetHandle]).toEqual(["out-right:person_id", "in-left:id"]);
    const tb = dagreLayout(twoTables, "TB").edges[0]!;
    expect(tb.sourceHandle!.split(":")[0]!.split("-")[1]).toBe(tb.targetHandle!.split(":")[0]!.split("-")[1]);
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

/** The same shape `/api/validate` returns, built from a real example schema. */
function exampleDiagram(file: string): SchemaDiagram {
  const schema = parseSchema(parse(readFileSync(new URL(`../../../examples/${file}`, import.meta.url), "utf8")));
  return { tables: Object.entries(schema.tables).map(([name, t]) => ({ name, rows: t.rows, columns: Object.entries(t.columns).map(([name, c]) => ({ name, type: c.type, primaryKey: !!c.primaryKey, unique: !!c.unique, nullable: !!c.nullable, ...(c.ref ? { ref: c.ref } : {}) })) })) };
}
const examples = readdirSync(new URL("../../../examples/", import.meta.url)).filter((f) => f.endsWith(".yaml") && !f.includes("openapi"));
const run = (engine: LayoutEngine, data: SchemaDiagram, direction: "LR" | "TB" = "LR") => (engine === "dagre" ? Promise.resolve(dagreLayout(data, direction)) : elkLayout(elk, data, direction, engine));

describe("every layout engine", () => {
  it("lists each engine once, with layered first", () => {
    expect(LAYOUT_ENGINES.map((e) => e.id)).toEqual(["layered", "dagre", "tree", "force", "stress", "grid"]);
  });
  it("uses column ports only for the layered engine", () => {
    expect(elkGraph(cyclic, "LR", "force").children!.every((n) => !n.ports)).toBe(true);
    expect(elkGraph(cyclic, "LR", "force").edges!.find((e) => e.id === "b.a->a.id")).toMatchObject({ sources: ["b"], targets: ["a"] });
    expect(elkGraph(cyclic, "TB", "tree").layoutOptions).toMatchObject({ "elk.algorithm": "mrtree", "elk.direction": "DOWN" });
  });
  for (const engine of LAYOUT_ENGINES.map((e) => e.id)) {
    it(`${engine}: places every example table without overlaps`, async () => {
      for (const file of examples) {
        const data = exampleDiagram(file);
        const layout = await run(engine, data);
        expect(layout.nodes.map((n) => n.id), file).toEqual(data.tables.map((t) => t.name));
        const boxes = layout.nodes.map((n) => ({ ...n.position, h: 48 + n.data.table.columns.length * 32 }));
        expect(boxes.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y)), file).toBe(true);
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const [a, b] = [boxes[i]!, boxes[j]!];
          const overlap = a.x < b.x + CARD_WIDTH && b.x < a.x + CARD_WIDTH && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${file}: ${layout.nodes[i]!.id} overlaps ${layout.nodes[j]!.id}`).toBe(false);
        }
      }
    });
  }
});

describe("landing page diagram", () => {
  it("is exactly what the server returns for its example schema", () => {
    expect(DIAGRAM).toEqual(exampleDiagram(DIAGRAM_EXAMPLE));
  });
});
