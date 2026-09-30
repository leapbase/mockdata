import { vi } from "vitest";

type Handler = (body: any, url: URL, init: RequestInit) => unknown | Promise<unknown>;

/** Stub global fetch with handlers keyed "METHOD /path". A handler may return a Response, a promise, or JSON-able data. */
export function stubApi(routes: Record<string, Handler>) {
  const calls: { key: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      const key = `${init.method ?? "GET"} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) return new Response(JSON.stringify({ error: { message: `unstubbed ${key}` } }), { status: 404 });
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ key, body });
      const out = await handler(body, url, init);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

/** An SSE response that emits the given events, then stays open until `signal` aborts (or closes if `end`). */
export function sseResponse(events: { event: string; data: unknown }[], opts: { end?: boolean; signal?: AbortSignal } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      if (opts.end) c.close();
      else opts.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
