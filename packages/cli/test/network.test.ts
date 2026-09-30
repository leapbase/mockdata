import { describe, expect, it } from "vitest";
import { listenPlan, localRequestProblem, NetworkConfigError, needsToken, networkAccess, parseAllow, parsePublicUrl, peerAllowed, remoteAllowed } from "../src/cli.js";

describe("parseAllow", () => {
  it("accepts single IPs, CIDRs and the a.b.c.x shorthand (a /24), comma separated", () => {
    const cidrs = parseAllow("100.100.1.x, 192.168.0.0/16,10.1.2.3");
    expect(cidrs.map((c) => c.text)).toEqual(["100.100.1.0/24", "192.168.0.0/16", "10.1.2.3/32"]);
  });

  it("refuses public ranges, ranges wider than /16, and malformed input", () => {
    for (const bad of ["8.8.8.0/24", "0.0.0.0/0", "100.0.0.0/8", "10.0.0.0/8", "172.15.0.0/16", "100.128.0.0/16", "100.100.1.300", "100.100.x.x", "nonsense", "", "100.100.1.0/33", "::1"]) {
      expect(() => parseAllow(bad), bad).toThrow(NetworkConfigError);
    }
  });
});

describe("remoteAllowed", () => {
  const allow = parseAllow("100.100.1.x");
  it("allows loopback always, listed addresses, and IPv4-mapped forms; refuses the rest", () => {
    for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.100.1.5", "100.100.1.255", "::ffff:100.100.1.9"]) expect(remoteAllowed(ok, allow), ok).toBe(true);
    for (const no of ["100.100.2.5", "100.100.0.255", "192.168.0.1", "8.8.8.8", "fe80::1", undefined, ""]) expect(remoteAllowed(no, allow), String(no)).toBe(false);
    expect(remoteAllowed("100.100.1.5", [])).toBe(false);
    expect(remoteAllowed("127.0.0.1", [])).toBe(true);
  });
});

describe("localRequestProblem with network access", () => {
  const access = networkAccess(parseAllow("100.100.1.x"), ["100.100.2.7"]);
  it("keeps the default rules when no access is configured", () => {
    expect(localRequestProblem("100.100.1.5:4747", undefined)).toMatch(/Host not allowed/);
    expect(localRequestProblem("localhost:4747", undefined)).toBeUndefined();
  });
  it("accepts an IP literal in the allowlist or one of this machine's own addresses", () => {
    expect(localRequestProblem("100.100.1.5:4747", undefined, access)).toBeUndefined();
    expect(localRequestProblem("100.100.2.7:4747", undefined, access)).toBeUndefined();
    expect(localRequestProblem("localhost:4747", undefined, access)).toBeUndefined();
  });
  it("still refuses other IPs and every hostname (DNS rebinding)", () => {
    for (const host of ["100.100.3.5:4747", "evil.example", "evil.example:4747", "100.100.1.5.evil.example", "intranet:4747", undefined]) {
      expect(localRequestProblem(host, undefined, access), String(host)).toMatch(/Host not allowed/);
    }
  });
  it("requires an Origin to be same-origin with the Host", () => {
    expect(localRequestProblem("100.100.1.5:4747", "http://100.100.1.5:4747", access)).toBeUndefined();
    expect(localRequestProblem("100.100.1.5:4747", "http://100.100.1.6:4747", access)).toMatch(/Origin/);
    expect(localRequestProblem("100.100.1.5:4747", "http://evil.example", access)).toMatch(/Origin/);
    expect(localRequestProblem("100.100.1.5:4747", "null", access)).toMatch(/Origin/);
  });
});

describe("public (accounts) mode", () => {
  it("parsePublicUrl accepts an https origin, or http only on localhost, and normalises it", () => {
    expect(parsePublicUrl("https://Mockdata.Example.com")).toEqual({ origin: "https://mockdata.example.com", host: "mockdata.example.com", secure: true });
    expect(parsePublicUrl("https://mockdata.example.com:8443/")).toEqual({ origin: "https://mockdata.example.com:8443", host: "mockdata.example.com", secure: true });
    expect(parsePublicUrl("http://localhost:4747")).toEqual({ origin: "http://localhost:4747", host: "localhost", secure: false });
    expect(parsePublicUrl("http://127.0.0.1:4747").secure).toBe(false);
  });

  it("parsePublicUrl refuses plain http on a real host, paths, credentials and junk, without echoing the value", () => {
    for (const bad of ["http://mockdata.example.com", "https://mockdata.example.com/app", "https://user:pw@mockdata.example.com", "https://mockdata.example.com/?x=1", "ftp://x.example.com", "mockdata.example.com", "", undefined]) {
      try {
        parsePublicUrl(bad);
        expect.unreachable(String(bad));
      } catch (e) {
        expect(e).toBeInstanceOf(NetworkConfigError);
        expect((e as Error).message).toMatch(/MOCKDATA_PUBLIC_URL/);
        if (bad) expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  const pub = parsePublicUrl("https://mockdata.example.com");
  it("listenPlan binds loopback by default, makes no token, and refuses to mix with --allow", () => {
    const plan = listenPlan({ publicUrl: pub });
    expect(plan.host).toBe("127.0.0.1");
    expect(plan.access).toMatchObject({ publicHost: "mockdata.example.com", trustLoopback: false });
    expect(plan.access?.token).toBeUndefined();
    expect(plan.tokenGenerated).toBe(false);
    expect(listenPlan({ publicUrl: pub, host: "0.0.0.0" }).host).toBe("0.0.0.0"); // login is the gate in this mode
    expect(() => listenPlan({ publicUrl: pub, allow: parseAllow("100.100.1.x") })).toThrow(NetworkConfigError);
  });

  it("accepts the public host name (and nothing else by name), keeps the same-origin rule, and serves any peer", () => {
    const access = listenPlan({ publicUrl: pub }).access!;
    expect(localRequestProblem("mockdata.example.com", undefined, access)).toBeUndefined();
    expect(localRequestProblem("MockData.Example.com", undefined, access)).toBeUndefined();
    expect(localRequestProblem("localhost:4747", undefined, access)).toBeUndefined();
    expect(localRequestProblem("evil.example", undefined, access)).toMatch(/Host not allowed/);
    expect(localRequestProblem("mockdata.example.com.evil.example", undefined, access)).toMatch(/Host not allowed/);
    expect(localRequestProblem("mockdata.example.com", "https://mockdata.example.com", access)).toBeUndefined();
    expect(localRequestProblem("mockdata.example.com", "https://evil.example", access)).toMatch(/Origin/);
    expect(peerAllowed(access, "203.0.113.9")).toBe(true);
    expect(peerAllowed(access, undefined)).toBe(true);
    expect(peerAllowed(undefined, "203.0.113.9")).toBe(true); // no access object: local mode, nothing to filter
    expect(needsToken(access, "203.0.113.9")).toBe(false);
  });
});
