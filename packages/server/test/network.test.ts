import { describe, expect, it } from "vitest";
import { NetworkConfigError, parseAllow } from "@mockdata/cli";
import { startServer } from "../src/index.js";
import { boot, rawRequest } from "./helpers.js";

describe("opening the UI beyond localhost", () => {
  const allow = parseAllow("100.100.1.x");

  it("serves an allowed IP as the Host, and still refuses other IPs and names", async () => {
    const { url } = await boot({ allow, localHosts: ["100.100.2.7"] });
    const at = (host: string, extra: Record<string, string> = {}) => rawRequest(url, "/api/config", { host, ...extra }).then((r) => r.status);
    expect(await at("100.100.1.5:4747")).toBe(200);
    expect(await at("100.100.2.7:4747")).toBe(200); // this machine's own address
    expect(await at("100.100.3.5:4747")).toBe(403);
    expect(await at("evil.example")).toBe(403);
    expect(await at("100.100.1.5:4747", { origin: "http://100.100.1.5:4747" })).toBe(200);
    expect(await at("100.100.1.5:4747", { origin: "http://100.100.1.6:4747" })).toBe(403);
  });

  it("does not accept those Hosts when no allow list is given", async () => {
    const { url } = await boot();
    expect((await rawRequest(url, "/api/config", { host: "100.100.1.5:4747" })).status).toBe(403);
  });

  it("binds beyond loopback only with an allow list, and refuses a public --host without one", async () => {
    await expect(startServer({ env: {}, port: 0, host: "0.0.0.0" })).rejects.toThrow(NetworkConfigError);
    const { server } = await startServer({ env: {}, port: 0, allow, localHosts: [] });
    try {
      expect((server.address() as { address: string }).address).toBe("0.0.0.0");
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
