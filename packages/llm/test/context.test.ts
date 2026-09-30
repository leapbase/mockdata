import { describe, expect, it } from "vitest";
import { parseSchema, SchemaError, type Dataset } from "@mockdata/core";
import { createContextBuilder, generateWithLlm, type LlmProvider } from "../src/index.js";

const schema = parseSchema({
  llm: { provider: "openai", model: "m" },
  tables: {
    brands: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string" } } },
    products: {
      rows: 2,
      columns: {
        id: { type: "integer", primaryKey: true },
        brand_id: { type: "integer", ref: "brands.id" },
        name: { type: "string" },
        category: { type: "string" },
      },
    },
    reviews: {
      rows: 2,
      columns: {
        id: { type: "integer", primaryKey: true },
        product_id: { type: "integer", ref: "products.id" },
        rating: { type: "integer" },
        body: { type: "string", llm: true },
      },
    },
  },
});

const data: Dataset = {
  brands: [{ id: 1, name: "Acme" }, { id: 2, name: "Globex" }],
  products: [
    { id: 1, brand_id: 2, name: "Widget", category: "Gadgets" },
    { id: 2, brand_id: 1, name: "X".repeat(80), category: null },
  ],
  reviews: [
    { id: 1, product_id: 1, rating: 2, body: undefined },
    { id: 2, product_id: 2, rating: 5, body: undefined },
  ],
};

const describeRow = (depth: number, table = "reviews", index = 0) =>
  JSON.parse(createContextBuilder(schema, data, depth).describe(table, data[table]![index]!, "body"));

describe("createContextBuilder", () => {
  it("depth 0 shows only the row itself, with the raw foreign key", () => {
    expect(describeRow(0)).toEqual({ id: 1, product_id: 1, rating: 2 });
  });

  it("depth 1 replaces the foreign key id with the parent's values (minus its key and unexpanded ids)", () => {
    expect(describeRow(1)).toEqual({ id: 1, rating: 2, product: { name: "Widget", category: "Gadgets" } });
  });

  it("depth 2 expands the parent's own foreign keys", () => {
    expect(describeRow(2)).toEqual({ id: 1, rating: 2, product: { name: "Widget", category: "Gadgets", brand: { name: "Globex" } } });
  });

  it("skips null parent values and clips long strings", () => {
    expect(describeRow(1, "reviews", 1).product).toEqual({ name: "X".repeat(57) + "..." });
  });

  it("never includes the column being written", () => {
    expect(JSON.parse(createContextBuilder(schema, { ...data, reviews: [{ id: 1, product_id: 1, rating: 2, body: "done" }] }, 1).describe("reviews", { id: 1, product_id: 1, rating: 2, body: "done" }, "body")).body).toBeUndefined();
  });

  it("keeps the raw id when the parent row cannot be found", () => {
    const orphan = { id: 9, product_id: 99, rating: 1 };
    expect(JSON.parse(createContextBuilder(schema, data, 1).describe("reviews", orphan, "body"))).toEqual({ id: 9, product_id: 99, rating: 1 });
  });

  it("sees values written into a parent after the builder was created", () => {
    const live: Dataset = { ...data, products: data.products!.map((p) => ({ ...p })) };
    const builder = createContextBuilder(schema, live, 1);
    live.products![0]!.category = "Updated";
    expect(JSON.parse(builder.describe("reviews", live.reviews![0]!, "body")).product.category).toBe("Updated");
  });

  it("names two foreign keys to the same table separately, and never overwrites an own column", () => {
    const s = parseSchema({
      tables: {
        users: { rows: 2, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string" } } },
        messages: {
          rows: 1,
          columns: {
            id: { type: "integer", primaryKey: true },
            sender_id: { type: "integer", ref: "users.id" },
            recipient_id: { type: "integer", ref: "users.id" },
            sender: { type: "string" },
          },
        },
      },
    });
    const d: Dataset = { users: [{ id: 1, name: "Ann" }, { id: 2, name: "Bo" }], messages: [{ id: 1, sender_id: 1, recipient_id: 2, sender: "own value" }] };
    const ctx = JSON.parse(createContextBuilder(s, d, 1).describe("messages", d.messages![0]!, "body"));
    expect(ctx).toEqual({ id: 1, sender: "own value", sender_id: { name: "Ann" }, recipient: { name: "Bo" } });
  });

  it("handles a self reference and stops at the depth limit", () => {
    const s = parseSchema({
      tables: { staff: { rows: 3, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string" }, manager_id: { type: "integer", ref: "staff.id", nullable: true } } } },
    });
    const d: Dataset = { staff: [{ id: 1, name: "Boss", manager_id: null }, { id: 2, name: "Mid", manager_id: 1 }, { id: 3, name: "New", manager_id: 2 }] };
    const at = (depth: number) => JSON.parse(createContextBuilder(s, d, depth).describe("staff", d.staff![2]!, "x"));
    expect(at(1)).toEqual({ id: 3, name: "New", manager: { name: "Mid" } });
    expect(at(2)).toEqual({ id: 3, name: "New", manager: { name: "Mid", manager: { name: "Boss" } } });
  });

  it("hasRelated is true only when depth > 0 and the table has a foreign key", () => {
    expect(createContextBuilder(schema, data, 1).hasRelated("reviews")).toBe(true);
    expect(createContextBuilder(schema, data, 1).hasRelated("brands")).toBe(false);
    expect(createContextBuilder(schema, data, 0).hasRelated("reviews")).toBe(false);
  });
});

describe("parent context in real prompts", () => {
  const withLlm = (depth?: number, order: "children-first" | "parents-first" = "children-first") => {
    const tables = {
      reviews: { rows: 4, columns: { id: { type: "integer", primaryKey: true }, product_id: { type: "integer", ref: "products.id" }, rating: { type: "integer", min: 1, max: 5 }, body: { type: "string", llm: { prompt: "a review" } } } },
      products: { rows: 3, columns: { id: { type: "integer", primaryKey: true }, name: { type: "string", faker: "commerce.productName" }, blurb: { type: "string", llm: { prompt: "a product blurb" } } } },
    };
    return {
      seed: 8,
      llm: { provider: "openai", model: "m", ...(depth === undefined ? {} : { contextDepth: depth }) },
      tables: order === "children-first" ? tables : { products: tables.products, reviews: tables.reviews },
    };
  };

  function recorder() {
    const prompts: string[] = [];
    const provider: LlmProvider = {
      name: "fake",
      async complete(req) {
        prompts.push(req.user);
        const n = Number(/exactly (\d+) strings/.exec(req.user)![1]);
        const table = /Table: (\w+)/.exec(req.user)![1];
        return { text: JSON.stringify(Array.from({ length: n }, (_, i) => `${table}-text-${i}`)), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    return { prompts, provider };
  }

  it("fills parent tables first, so children see the text the model wrote for their parents", async () => {
    const { prompts, provider } = recorder();
    const { data } = await generateWithLlm(withLlm(), { provider, sleep: async () => {} });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Table: products"); // parents first even though reviews is declared first
    expect(prompts[1]).toContain("Table: reviews");
    expect(prompts[1]).toContain('"blurb":"products-text-');
    const first = data.reviews![0]!;
    const product = data.products!.find((p) => p.id === first.product_id)!;
    expect(prompts[1]).toContain(JSON.stringify(product.name));
    expect(prompts[1]).not.toContain('"product_id"');
    expect(prompts[1]).toContain("keep values varied even when several rows share the same related row");
  });

  it("contextDepth 0 in the schema turns parent context off", async () => {
    const { prompts, provider } = recorder();
    await generateWithLlm(withLlm(0), { provider, sleep: async () => {} });
    expect(prompts[1]).toContain('"product_id"');
    expect(prompts[1]).not.toContain('"product":{');
    expect(prompts[1]).not.toContain("nested under another name");
  });

  it("does not add the parent-context sentence for tables without foreign keys", async () => {
    const { prompts, provider } = recorder();
    await generateWithLlm(withLlm(), { provider, sleep: async () => {} });
    expect(prompts[0]).not.toContain("nested under another name");
  });

  it("rejects an out-of-range contextDepth", () => {
    expect(() => parseSchema(withLlm(3))).toThrow(SchemaError);
  });
});
