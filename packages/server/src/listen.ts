import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "./app.js";

/** Listen on 127.0.0.1 only. `port: 0` picks a free port (tests). */
export async function startServer(opts: AppOptions & { port?: number } = {}): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(createApp(opts));
  // Bound how long a client may dawdle over headers or a body (slowloris); generation itself happens after the body is in.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4747, "127.0.0.1", () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
