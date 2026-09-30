import http from "node:http";
import type { AddressInfo } from "node:net";
import { dropForeignConnections, listenPlan, type ListenOptions } from "@mockdata/cli";
import { createApp, type AppOptions } from "./app.js";
import { createRunner, type PoolSettings } from "./workers/factory.js";

/**
 * Listen on 127.0.0.1 only, unless `allow` names private ranges that may also connect
 * (then on 0.0.0.0, dropping everyone else). `port: 0` picks a free port (tests).
 * The returned url is always the loopback one.
 */
export async function startServer(
  opts: Omit<AppOptions, "access"> & Omit<ListenOptions, "publicUrl"> & {
    port?: number;
    /** Run generation in worker threads (see poolSettingsFromEnv). Without it (tests, embedding) jobs run on the calling thread. */
    workers?: PoolSettings & { workerFile?: string };
  } = {},
): Promise<{ server: http.Server; url: string; token?: string; tokenGenerated: boolean }> {
  const { host, access, tokenGenerated } = listenPlan({ ...opts, publicUrl: opts.accounts?.config.publicUrl });
  // A pool we create is ours to stop; a runner passed in belongs to the caller.
  const ownRunner = !opts.runner && opts.workers ? createRunner(opts.workers, { workerFile: opts.workers.workerFile, llm: opts.llm }) : undefined;
  const server = http.createServer(createApp({ ...opts, access, runner: opts.runner ?? ownRunner }));
  server.on("close", () => void ownRunner?.close());
  dropForeignConnections(server, access);
  // Bound how long a client may dawdle over headers or a body (slowloris); generation itself happens after the body is in.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 4747, host, () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: access?.token, tokenGenerated };
}
