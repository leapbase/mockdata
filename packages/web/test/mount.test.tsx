// @vitest-environment jsdom
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
    await vi.waitFor(() => expect(box.querySelector("h1")).toBeTruthy()); // the landing page at "/"
    await act(async () => unmount());
    expect(box.innerHTML).toBe("");
  });
});
