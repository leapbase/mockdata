import http from "node:http";
import type { AddressInfo } from "node:net";
import { dropForeignConnections, listenPlan, type ListenOptions } from "@mockdata/cli";
import { createApp, type AppOptions } from "./app.js";

/**
 * Listen on 127.0.0.1 only, unless `allow` names private ranges that may also connect
 * (then on 0.0.0.0, dropping everyone else). `port: 0` picks a free port (tests).
 * The returned url is always the loopback one.
 */
export async function startServer(opts: Omit<AppOptions, "access"> & ListenOptions & { port?: number } = {}): Promise<{ server: http.Server; url: string }> {
  const { host, access } = listenPlan(opts);
  const server = http.createServer(createApp({ ...opts, access }));
  dropForeignConnections(server, access);
  // Bound how long a client may dawdle over headers or a body (slowloris); generation itself happens after the body is in.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4747, host, () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
