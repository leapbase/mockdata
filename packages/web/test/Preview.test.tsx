// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import Preview from "../src/components/Preview";
import type { Preview as PreviewData } from "../src/api";

afterEach(cleanup);

const data = (over: Partial<PreviewData> = {}): PreviewData => ({
  seed: 1,
  counts: { customers: 100, orders: 2 },
  pending: [],
  tables: {
    customers: {
      columns: ["id", "name"],
      refs: {},
      rows: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `c${i + 1}` })),
    },
    orders: {
      columns: ["id", "customer_id"],
      refs: { customer_id: "customers.id" },
      rows: [
        { id: 1, customer_id: 2 },
        { id: 2, customer_id: 99 },
      ],
    },
  },
  ...over,
});

describe("Preview", () => {
  it("selects the requested table, again on a new request after the user switched tabs", async () => {
    const { rerender } = render(<Preview data={data()} select={{ table: "orders", nonce: 1 }} />);
    expect(screen.getByRole("tab", { name: /orders/ }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: /customers/ }));
    expect(screen.getByRole("tab", { name: /customers/ }).getAttribute("aria-selected")).toBe("true");
    rerender(<Preview data={data()} select={{ table: "orders", nonce: 1 }} />);
    expect(screen.getByRole("tab", { name: /customers/ }).getAttribute("aria-selected")).toBe("true");
    rerender(<Preview data={data()} select={{ table: "orders", nonce: 2 }} />);
    expect(screen.getByRole("tab", { name: /orders/ }).getAttribute("aria-selected")).toBe("true");
  });
  it("ignores a request for a table the preview does not have", () => {
    render(<Preview data={data()} select={{ table: "ghost", nonce: 1 }} />);
    expect(screen.getByRole("tab", { name: /customers/ }).getAttribute("aria-selected")).toBe("true");
  });
  it("moves between result tables with arrow keys and keeps one keyboard tab stop", async () => {
    render(<Preview data={data()} />);
    const customers = screen.getByRole("tab", { name: /customers/ });
    const orders = screen.getByRole("tab", { name: /orders/ });
    expect(customers.tabIndex).toBe(0);
    expect(orders.tabIndex).toBe(-1);
    customers.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(orders);
    expect(orders.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("table", { name: "orders preview" })).toBeTruthy();
  });
  it("shows a tab per table with the total row count and the shown rows", () => {
    render(<Preview data={data()} />);
    expect(screen.getByRole("tab", { name: /customers/ }).textContent).toContain("100");
    expect(screen.getAllByRole("row")).toHaveLength(1 + 3);
    expect(screen.getByText("showing 3 of 100")).toBeTruthy();
  });

  it("jumps to the parent row when a foreign key is clicked", async () => {
    render(<Preview data={data()} />);
    await userEvent.click(screen.getByRole("tab", { name: /orders/ }));
    await userEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByRole("tab", { name: /customers/ }).getAttribute("aria-selected")).toBe("true");
    const focused = document.querySelector("tr.focus")!;
    expect(within(focused as HTMLElement).getByText("c2")).toBeTruthy();
  });

  it("says so when the parent row is beyond the preview", async () => {
    render(<Preview data={data()} />);
    await userEvent.click(screen.getByRole("tab", { name: /orders/ }));
    await userEvent.click(screen.getByRole("button", { name: "99" }));
    expect(screen.getByText(/beyond the first 3 rows/)).toBeTruthy();
  });

  it("renders null, objects, booleans, long text and markup as inert text", () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    render(
      <Preview
        data={data({
          counts: { t: 1 },
          tables: { t: { columns: ["a", "b", "c", "d", "e"], refs: {}, rows: [{ a: null, b: { x: 1 }, c: true, d: "z".repeat(5000), e: payload }] } },
        })}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText('{"x":1}')).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.getByText(payload)).toBeTruthy();
  });

  it("marks llm columns that have no values yet", () => {
    render(
      <Preview
        data={data({ pending: ["notes.body"], counts: { notes: 1 }, tables: { notes: { columns: ["id", "body"], refs: {}, rows: [{ id: 1, body: null }] } } })}
      />,
    );
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText(/1 LLM column/)).toBeTruthy();
  });

  it("can switch to a raw JSON view", async () => {
    render(<Preview data={data()} />);
    await userEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
    expect(screen.getByText(/"name": "c1"/)).toBeTruthy();
  });

  it("copes with a new preview that no longer has the selected table", () => {
    const { rerender } = render(<Preview data={data()} />);
    rerender(<Preview data={data({ tables: { only: { columns: ["x"], refs: {}, rows: [{ x: 1 }] } }, counts: { only: 1 } })} />);
    expect(screen.getByRole("tab", { name: /only/ }).getAttribute("aria-selected")).toBe("true");
  });
});
