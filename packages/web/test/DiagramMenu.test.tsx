// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DdlDialog, TableMenu } from "../src/components/DiagramMenu";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const col = (name: string, extra = {}) => ({ name, type: "integer", primaryKey: false, unique: false, nullable: false, ...extra });
const people = { name: "people", rows: 2, columns: [col("id", { primaryKey: true })] };
const orders = { name: "orders", rows: 3, columns: [col("id", { primaryKey: true }), col("person_id", { ref: "people.id" })] };

describe("TableMenu", () => {
  const setup = (hasData = true) => {
    const onDdl = vi.fn(), onCopyName = vi.fn(), onClose = vi.fn(), onShowData = vi.fn();
    render(<div><button>outside</button><TableMenu menu={{ table: "orders", x: 10, y: 10 }} hasData={hasData} onShowData={onShowData} onDdl={onDdl} onCopyName={onCopyName} onClose={onClose} /></div>);
    return { onDdl, onCopyName, onClose, onShowData };
  };
  it("lists show data, the dialects and copy, focusing the first item", () => {
    setup();
    expect(screen.getByRole("menu", { name: "Table orders" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Show data", "PostgreSQL", "MySQL", "SQLite", "Copy table name"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Show data" }));
  });
  it("runs show data when the table has data", async () => {
    const { onShowData } = setup(true);
    await userEvent.click(screen.getByRole("menuitem", { name: "Show data" }));
    expect(onShowData).toHaveBeenCalledTimes(1);
  });
  it("disables show data without data: explained, still focusable, and a click does nothing", async () => {
    const { onShowData, onClose } = setup(false);
    const item = screen.getByRole("menuitem", { name: "Show data" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe("Generate data first");
    expect(document.activeElement).toBe(item);
    await userEvent.click(item);
    expect(onShowData).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("picks a dialect and a copy action", async () => {
    const { onDdl, onCopyName } = setup();
    await userEvent.click(screen.getByRole("menuitem", { name: "MySQL" }));
    expect(onDdl).toHaveBeenCalledWith("mysql");
    await userEvent.click(screen.getByRole("menuitem", { name: "Copy table name" }));
    expect(onCopyName).toHaveBeenCalled();
  });
  it("moves with arrow keys and closes on Escape or an outside click", async () => {
    const { onClose } = setup();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "MySQL" }));
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Copy table name" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByText("outside"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("DdlDialog", () => {
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? <DdlDialog table={orders} all={[people, orders]} initial="postgres" onClose={() => setOpen(false)} /> : <p>closed</p>;
  }
  it("shows the DDL, switches dialect and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Host />);
    expect(screen.getByLabelText("DDL").textContent).toContain('CREATE TABLE "orders"');
    await userEvent.selectOptions(screen.getByLabelText("Dialect"), "mysql");
    expect(screen.getByLabelText("DDL").textContent).toContain("CREATE TABLE `orders`");
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("FOREIGN KEY (`person_id`) REFERENCES `people` (`id`)"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
  it("reports a failed copy and closes with the close button", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Copy failed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByText("closed")).toBeTruthy();
  });
});
