// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import Modal from "../src/components/Modal";
afterEach(cleanup);
it("captures focus and returns it to the opener when Escape closes a modal", async () => {
  function Example() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open</button>{open && <Modal title="Export" onClose={() => setOpen(false)}><input aria-label="Output folder" /></Modal>}</>;
  }
  render(<Example />);
  const opener = screen.getByRole("button", { name: "Open" });
  await userEvent.click(opener);
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});
