// Starter schemas offered on an empty draft. The text is the repo's own examples/*.yaml, loaded on demand so it stays off the workspace bundle.

export interface Template {
  /** Also the suggested file name: `<id>.yaml`. */
  id: string;
  title: string;
  blurb: string;
  load: () => Promise<string>;
}

const raw = (m: { default: string }) => m.default;

export const TEMPLATES: Template[] = [
  { id: "shop", title: "Online shop", blurb: "Customers and their orders, a few customers placing most of them (zipf).", load: () => import("../../../examples/shop.yaml?raw").then(raw) },
  { id: "shop-llm", title: "Product reviews by a model", blurb: "Products and reviews whose text an LLM writes from each rating and product.", load: () => import("../../../examples/shop-llm.yaml?raw").then(raw) },
  { id: "hr", title: "HR", blurb: "Departments, employees, parking and equipment: patterns, one-to-one links, a self reference and a date rule.", load: () => import("../../../examples/hr.yaml?raw").then(raw) },
  { id: "supply-chain", title: "Supply chain", blurb: "Nine tables tracking serialized packs from manufacturer to pharmacy.", load: () => import("../../../examples/supply-chain.yaml?raw").then(raw) },
];
