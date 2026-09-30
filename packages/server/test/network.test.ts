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

describe("shared secret token", () => {
  const allow = parseAllow("100.100.1.x");
  const TOKEN = "s3cret-token-0123456789";
  const open = () => boot({ allow, localHosts: [], token: TOKEN, trustLoopback: false });

  it("rejects requests without the token, and with a wrong one", async () => {
    const { get, call } = await open();
    const none = await get("/api/config");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await call("GET", "/api/config", undefined, { authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
    expect((await call("GET", "/", undefined, {})).status).toBe(401);
  });

  it("accepts a Bearer header", async () => {
    const { call } = await open();
    expect((await call("GET", "/api/config", undefined, { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("turns ?token= into an HttpOnly SameSite=Strict cookie and a clean redirect, which then works", async () => {
    const { url } = await open();
    const r = await fetch(`${url}/?token=${TOKEN}&x=1`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/?x=1"); // the token is gone from the URL
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^mockdata_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const again = await fetch(`${url}/api/config`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(again.status).toBe(200);
  });

  it("does not accept ?token= on API calls, or a wrong token on the redirect", async () => {
    const { url } = await open();
    expect((await fetch(`${url}/api/config?token=${TOKEN}`, { redirect: "manual" })).status).toBe(401);
    expect((await fetch(`${url}/?token=wrong-token-0123456789`, { redirect: "manual" })).status).toBe(401);
  });

  it("is not required from localhost by default, and never echoes the token", async () => {
    const trusting = await boot({ allow, localHosts: [], token: TOKEN });
    expect((await trusting.get("/api/config")).status).toBe(200);
    const { get } = await open();
    expect((await get("/api/config")).raw).not.toContain(TOKEN);
  });
});
