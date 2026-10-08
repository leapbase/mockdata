// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header, LocalGate, Root, mountApp } from "../src/index";
import { stubApi } from "./stub";

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("the web package as a library", () => {
  it("exports what a hosted shell builds on", () => {
    for (const part of [Header, LocalGate, Root, mountApp]) expect(typeof part).toBe("function");
  });

  it("mountApp renders Root into the given container and unmounts cleanly", async () => {
    stubApi({});
    const box = document.createElement("div");
    document.body.append(box);
    let unmount = () => undefined as void;
    await act(async () => {
      unmount = mountApp({}, box);
    });
    await vi.waitFor(() => expect(box.textContent).toContain("Local workspace")); // the workspace at "/"
    await act(async () => unmount());
    expect(box.innerHTML).toBe("");
  });
});

describe("subpath exports an embedding shell's tests rely on", () => {
  it("resolve to the real modules", () => {
    const pkg = JSON.parse(readFileSync(resolve("packages/web/package.json"), "utf8"));
    for (const target of Object.values(pkg.exports as Record<string, string>)) {
      expect(existsSync(resolve("packages/web", target)), target).toBe(true);
    }
  });
});
