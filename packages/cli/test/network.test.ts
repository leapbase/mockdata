import { describe, expect, it } from "vitest";
import { localRequestProblem, NetworkConfigError, networkAccess, parseAllow, remoteAllowed } from "../src/cli.js";

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
