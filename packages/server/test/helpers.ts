import { mkdtempSync, realpathSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { startServer } from "../src/index.js";

type AppOptions = NonNullable<Parameters<typeof startServer>[0]>;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

export const tmpRoot = () => realpathSync(mkdtempSync(join(tmpdir(), "mockdata-server-")));

export const SHOP_YAML = `seed: 7
tables:
  customers:
    rows: 6
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: person.fullName }
  orders:
    rows: 15
    columns:
      id: { type: integer, primaryKey: true }
      customer_id: { type: integer, ref: customers.id }
      total: { type: float, min: 1, max: 9 }
`;

/** Start a real server on an ephemeral port with an empty env and a temp root (so a real .env never leaks in). */
export async function boot(opts: AppOptions = {}) {
  const root = opts.root ?? tmpRoot();
  const { server, url } = await startServer({ env: {}, ...opts, root, port: 0 });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(url + path, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, raw, json };
  }
  return { root, url, call, get: (p: string) => call("GET", p), post: (p: string, b: unknown) => call("POST", p, b), put: (p: string, b: unknown) => call("PUT", p, b) };
}

/** Send a request with arbitrary headers (fetch will not let a test set Host). */
export function rawRequest(url: string, path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
