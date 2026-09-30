import { describe, expect, it } from "vitest";
import { generateToken, listenPlan, NetworkConfigError, parseAllow, presentedToken, tokenFromEnv, tokensEqual } from "../src/cli.js";

describe("tokens", () => {
  it("generates long, distinct, url-safe tokens", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(generateToken()).not.toBe(a);
  });

  it("reads MOCKDATA_TOKEN, trimmed, and refuses short ones without echoing the value", () => {
    expect(tokenFromEnv({})).toBeUndefined();
    expect(tokenFromEnv({ MOCKDATA_TOKEN: "  " })).toBeUndefined();
    expect(tokenFromEnv({ MOCKDATA_TOKEN: " abcdefghijklmnop " })).toBe("abcdefghijklmnop");
    try {
      tokenFromEnv({ MOCKDATA_TOKEN: "tooshort" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(NetworkConfigError);
      expect((e as Error).message).toMatch(/MOCKDATA_TOKEN/);
      expect((e as Error).message).not.toContain("tooshort");
    }
  });

  it("compares in constant time, treating different lengths as unequal", () => {
    expect(tokensEqual("abcdefghijklmnop", "abcdefghijklmnop")).toBe(true);
    expect(tokensEqual("abcdefghijklmnop", "abcdefghijklmnoq")).toBe(false);
    expect(tokensEqual("abcdefghijklmnop", "abc")).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
  });

  it("finds the token in a Bearer header or the cookie, and ignores other schemes and cookies", () => {
    expect(presentedToken({ authorization: "Bearer tok123" })).toBe("tok123");
    expect(presentedToken({ authorization: "bearer   tok123 " })).toBe("tok123");
    expect(presentedToken({ authorization: "Basic dXNlcjpwdw==" })).toBeUndefined();
    expect(presentedToken({ cookie: "a=1; mockdata_token=tok456; b=2" })).toBe("tok456");
    expect(presentedToken({ cookie: "other=tok456" })).toBeUndefined();
    expect(presentedToken({ authorization: "Bearer hdr", cookie: "mockdata_token=cookie" })).toBe("hdr");
    expect(presentedToken({})).toBeUndefined();
  });
});

describe("listenPlan with a token", () => {
  const allow = parseAllow("100.100.1.x");
  it("opens with a generated token unless one is given, and reports which", () => {
    const made = listenPlan({ allow, localHosts: [] });
    expect(made.access?.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(made.tokenGenerated).toBe(true);
    const given = listenPlan({ allow, localHosts: [], token: "abcdefghijklmnop" });
    expect(given.access?.token).toBe("abcdefghijklmnop");
    expect(given.tokenGenerated).toBe(false);
    expect(() => listenPlan({ allow, localHosts: [], token: "short" })).toThrow(NetworkConfigError);
  });
  it("needs no token when staying on localhost", () => {
    expect(listenPlan({}).access).toBeUndefined();
    expect(() => listenPlan({ token: "abcdefghijklmnop" })).not.toThrow();
  });
});
