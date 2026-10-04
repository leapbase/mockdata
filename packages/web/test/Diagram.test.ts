import { describe, expect, it } from "vitest";
import { diagramGraph } from "../src/components/SchemaDiagram";
import type { DiagramColumn } from "../src/api";
const id: DiagramColumn = { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false };
describe("schema diagram layout", () => {
  it("connects references to the correct column handles without overlapping tables", () => {
    const graph = diagramGraph({ tables: [
      { name: "people", rows: 2, columns: [id] },
      { name: "orders", rows: 4, columns: [id, { ...id, name: "person_id", primaryKey: false, ref: "people.id" }] },
    ] });
    expect(graph.edges[0]).toMatchObject({ source: "orders", sourceHandle: "person_id", target: "people", targetHandle: "id" });
    const [a, b] = graph.nodes;
    expect(Math.abs(a!.position.x - b!.position.x)).toBeGreaterThanOrEqual(290);
    expect(graph.nodes[1]!.data.table.rows).toBe(4);
  });
  it("lays out self references and cycles with finite positions", () => {
    const graph = diagramGraph({ tables: [
      { name: "a", rows: 2, columns: [id, { ...id, name: "parent", nullable: true, ref: "a.id" }, { ...id, name: "b", nullable: true, ref: "b.id" }] },
      { name: "b", rows: 2, columns: [id, { ...id, name: "a", ref: "a.id" }] },
    ] });
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]).toMatchObject({ source: "a", target: "a", sourceHandle: "parent", targetHandle: "self-id" });
    expect(graph.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
  });
});
