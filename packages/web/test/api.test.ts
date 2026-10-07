// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, exportZip, getFile, streamGenerate, validate } from "../src/api";
import { errorResponse, sseResponse, stubApi } from "./stub";

afterEach(() => vi.unstubAllGlobals());

describe("api client", () => {
  it("turns the server's error body into an ApiError carrying the message and status", async () => {
    stubApi({ "POST /api/validate": () => errorResponse(400, "nope") });
    const err = await validate("x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: "nope", status: 400, code: undefined });
  });
  it("keeps the server's reason code, and falls back to the status when there is no body", async () => {
    stubApi({ "POST /api/thing": () => new Response(JSON.stringify({ error: { message: "Verify first", code: "email_unverified" } }), { status: 403 }), "POST /api/validate": () => new Response("<html>", { status: 502 }) });
    const { json } = await import("../src/api");
    expect(await json("POST", "/api/thing", {}).catch((e) => e)).toMatchObject({ message: "Verify first", status: 403, code: "email_unverified" });
    expect(await validate("x").catch((e) => e)).toMatchObject({ message: "HTTP 502", status: 502 });
  });
  it("encodes paths in the query", async () => {
    const calls = stubApi({ "GET /api/file": () => ({ text: "t" }) });
    expect(await getFile("a b/c.yaml")).toBe("t");
    expect(String((fetch as any).mock.calls[0][0])).toBe("/api/file?path=a%20b%2Fc.yaml");
    expect(calls).toHaveLength(1);
  });
  it("posts zip requests without outputDir", async () => {
    const calls = stubApi({ "POST /api/export": () => new Response(new Blob(["z"])) });
    await exportZip({ text: "t", format: "csv", outputDir: "out" });
    expect(calls[0]!.body).toEqual({ text: "t", format: "csv", zip: true });
  });
  it("streams progress and resolves with the done payload", async () => {
    stubApi({
      "POST /api/generate/stream": () =>
        sseResponse([{ event: "progress", data: { column: "a.b", done: 1, total: 2 } }, { event: "done", data: { seed: 1, counts: {}, tables: {}, pending: [] } }], { end: true }),
    });
    const seen: number[] = [];
    const p = await streamGenerate({ text: "t" }, (e) => seen.push(e.done), new AbortController().signal);
    expect(seen).toEqual([1]);
    expect(p.seed).toBe(1);
  });
  it("throws the server's error event, and when the stream ends early", async () => {
    stubApi({ "POST /api/generate/stream": () => sseResponse([{ event: "error", data: { message: "model down" } }], { end: true }) });
    await expect(streamGenerate({ text: "t" }, () => {}, new AbortController().signal)).rejects.toThrow("model down");
    stubApi({ "POST /api/generate/stream": () => sseResponse([], { end: true }) });
    await expect(streamGenerate({ text: "t" }, () => {}, new AbortController().signal)).rejects.toThrow(/before the run finished/);
  });
});
