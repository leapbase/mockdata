import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";

/** Thrown for bad user input; the same class confined.ts uses (re-exported there). */
export class NetworkConfigError extends Error {}

export interface Cidr {
  base: number;
  mask: number;
  /** Normalised "a.b.c.d/n". */
  text: string;
}

/** Who may reach a server that is listening beyond localhost. Without one, only localhost is served. */
export interface NetworkAccess {
  allow: Cidr[];
  /** This machine's own IPv4 addresses: accepted as a Host header (an IP literal cannot be DNS-rebound). */
  hosts: Set<string>;
  /** Shared secret: required of every peer that is not exempt (see needsToken). */
  token?: string;
  /** Localhost peers skip the token (default true). Tests turn this off to exercise it over loopback. */
  trustLoopback: boolean;
  /**
   * Accounts mode: the public host name (from MOCKDATA_PUBLIC_URL). The server is open to any peer, because
   * a login session is the gate; there is no allow list or token, and loopback is never trusted (a
   * TLS-terminating reverse proxy connects from loopback on behalf of the whole internet).
   */
  publicHost?: string;
}

export interface PublicUrl {
  /** scheme://host[:port], no trailing slash. */
  origin: string;
  /** Lower-case host name without the port. */
  host: string;
  /** https: cookies get the Secure flag and HSTS is sent. */
  secure: boolean;
}

/**
 * MOCKDATA_PUBLIC_URL: the address people type. https, or plain http only on localhost (development and
 * tests); an origin, nothing more. Errors name the variable, never its value.
 */
export function parsePublicUrl(text: string | undefined): PublicUrl {
  const fail = () =>
    new NetworkConfigError("MOCKDATA_PUBLIC_URL must be an https origin such as https://your-domain.example (plain http is only accepted for localhost), with no path, query or credentials");
  let url: URL;
  try {
    url = new URL(text ?? "");
  } catch {
    throw fail();
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const okScheme = url.protocol === "https:" || (url.protocol === "http:" && local);
  if (!okScheme || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw fail();
  return { origin: url.origin, host: url.hostname.toLowerCase(), secure: url.protocol === "https:" };
}

/** Private ranges a caller may be allowed from. There is no authentication, so public ranges are refused. */
const PRIVATE = [cidr("10.0.0.0/8"), cidr("172.16.0.0/12"), cidr("192.168.0.0/16"), cidr("100.64.0.0/10")];
const MIN_PREFIX = 16;

function ipv4(text: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function cidr(text: string): Cidr {
  const [ip, len = "32"] = text.split("/");
  const base = ipv4(ip ?? "");
  const bits = Number(len);
  if (base === undefined || !/^\d+$/.test(len) || bits > 32) throw new NetworkConfigError(`Invalid address "${text}"`);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, text: `${ip}/${bits}` };
}

const within = (inner: Cidr, outer: Cidr) => (inner.mask & outer.mask) >>> 0 === outer.mask && ((inner.base & outer.mask) >>> 0) === outer.base;

/**
 * Parse an allow list: comma-separated single IPs ("10.1.2.3"), CIDRs
 * ("192.168.0.0/16") or the shorthand "100.100.1.x" (a /24). Every entry must
 * sit inside a private range and be at most as wide as a /16.
 */
export function parseAllow(spec: string): Cidr[] {
  const items = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new NetworkConfigError("--allow needs at least one address, e.g. 100.100.1.x");
  return items.map((item) => {
    const shorthand = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.x$/.exec(item);
    const c = cidr(shorthand ? `${shorthand[1]}.0/24` : item);
    if (!PRIVATE.some((p) => within(c, p))) {
      throw new NetworkConfigError(`"${item}" is not a private address range (10/8, 172.16/12, 192.168/16, 100.64/10): private-network mode has no per-user login (only a shared token), so it must not be opened to the internet; for a public site use accounts mode (MOCKDATA_PUBLIC_URL)`);
    }
    if (Number(c.text.split("/")[1]) < MIN_PREFIX) throw new NetworkConfigError(`"${item}" is wider than a /${MIN_PREFIX}; list a narrower range`);
    return c;
  });
}

/** Strip the IPv4-mapped IPv6 prefix Node reports for IPv4 peers on a dual-stack socket. */
function plainAddress(addr: string): string {
  return addr.toLowerCase().replace(/^::ffff:/, "");
}

export function isLoopback(addr: string): boolean {
  const a = plainAddress(addr);
  return a === "::1" || a.startsWith("127.");
}

/** Is this peer served at all? Accounts mode serves everyone (sessions gate it); otherwise see remoteAllowed. No access object means local mode, which only listens on loopback. */
export function peerAllowed(access: NetworkAccess | undefined, addr: string | undefined): boolean {
  if (!access || access.publicHost !== undefined) return true;
  return remoteAllowed(addr, access.allow);
}

/** Is this peer address one we serve? Loopback always; otherwise it must be inside the allow list. */
export function remoteAllowed(addr: string | undefined, allow: Cidr[]): boolean {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  const ip = ipv4(plainAddress(addr));
  return ip !== undefined && allow.some((c) => ((ip & c.mask) >>> 0) === c.base);
}

/** This machine's IPv4 addresses (for accepting them as Host, and for telling the user where to connect). */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}

export function networkAccess(allow: Cidr[], hosts: string[] = localAddresses(), token?: string, trustLoopback = true): NetworkAccess {
  return { allow, hosts: new Set(hosts), token, trustLoopback };
}

export const TOKEN_COOKIE = "mockdata_token";
const MIN_TOKEN_LENGTH = 16;

/** A fresh 192-bit token, URL- and cookie-safe. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * MOCKDATA_TOKEN from the environment (or .env): undefined when unset. It must be at
 * least 16 characters of [A-Za-z0-9._~-] so it is safe in a cookie and a URL. Errors name
 * the variable, never its value.
 */
export function tokenFromEnv(env: Record<string, string | undefined>): string | undefined {
  const value = env.MOCKDATA_TOKEN?.trim();
  if (!value) return undefined;
  if (value.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(value)) {
    throw new NetworkConfigError(`MOCKDATA_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters from A-Z a-z 0-9 . _ ~ - (leave it unset to get a generated one)`);
  }
  return value;
}

/** Constant-time comparison (hashing first, so length does not leak either). */
export function tokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

interface TokenHeaders {
  authorization?: string | string[];
  cookie?: string | string[];
}

/** The token a request carries: a Bearer header first, then (unless `cookie: false`) the cookie. */
export function presentedToken(headers: TokenHeaders, opts: { cookie?: boolean } = {}): string | undefined {
  const auth = [headers.authorization].flat()[0];
  const bearer = auth ? /^bearer\s+(\S+)\s*$/i.exec(auth.trim())?.[1] : undefined;
  if (bearer) return bearer;
  if (opts.cookie === false) return undefined;
  for (const part of ([headers.cookie].flat()[0] ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === TOKEN_COOKIE) return rest.join("=");
  }
  return undefined;
}

/** Must this peer prove it knows the token? Every non-loopback peer, and loopback too when `trustLoopback` is off. */
export function needsToken(access: NetworkAccess | undefined, remoteAddress: string | undefined): boolean {
  if (!access?.token) return false;
  return !(access.trustLoopback && remoteAddress !== undefined && isLoopback(remoteAddress));
}

/** May this Host-header hostname (no port, no brackets) be served? Used for Host and for Origin. */
export function hostnameAllowed(hostname: string, access?: NetworkAccess): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (!access) return false;
  if (access.publicHost !== undefined && h === access.publicHost) return true;
  const ip = ipv4(h);
  if (ip === undefined) return false; // names can be re-pointed by DNS; only IP literals are accepted
  return access.hosts.has(h) || access.allow.some((c) => ((ip & c.mask) >>> 0) === c.base);
}

export interface ListenOptions {
  host?: string;
  /** Private ranges allowed to connect besides localhost. Giving any opens the server beyond localhost. */
  allow?: Cidr[];
  /** Override this machine's addresses (tests). */
  localHosts?: string[];
  /** Shared secret for peers beyond localhost (default: a generated one, see tokenFromEnv). */
  token?: string;
  /** Tests only: also demand the token from localhost peers. */
  trustLoopback?: boolean;
  /** Accounts mode (MOCKDATA_PUBLIC_URL): sessions are the gate instead of an allow list and token. */
  publicUrl?: PublicUrl;
}

/**
 * Where to bind and who to serve. Default: 127.0.0.1, localhost only. With an
 * allow list the default becomes 0.0.0.0 (connections from outside the list are
 * dropped, see dropForeignConnections) and a shared secret is required of those peers: the
 * given one, or a generated one (`tokenGenerated`). Binding beyond loopback without an allow
 * list is refused rather than silently opening the server to everyone.
 */
export function listenPlan(opts: ListenOptions): { host: string; access?: NetworkAccess; tokenGenerated: boolean } {
  if (opts.publicUrl) {
    if ((opts.allow ?? []).length > 0) throw new NetworkConfigError("--allow cannot be combined with MOCKDATA_PUBLIC_URL: accounts mode is open to any visitor and gates them by login");
    const access: NetworkAccess = { allow: [], hosts: new Set(), trustLoopback: false, publicHost: opts.publicUrl.host };
    return { host: opts.host ?? "127.0.0.1", access, tokenGenerated: false };
  }
  const allow = opts.allow ?? [];
  const host = opts.host ?? (allow.length > 0 ? "0.0.0.0" : "127.0.0.1");
  if (allow.length === 0) {
    if (host !== "localhost" && !isLoopback(host)) {
      throw new NetworkConfigError(`Listening on "${host}" needs --allow (e.g. --allow 100.100.1.x): private-network mode has no per-user login, so you must say who may connect`);
    }
    return { host, tokenGenerated: false };
  }
  if (opts.token !== undefined) tokenFromEnv({ MOCKDATA_TOKEN: opts.token }); // same rules as the environment variable
  const token = opts.token ?? generateToken();
  return { host, access: networkAccess(allow, opts.localHosts, token, opts.trustLoopback ?? true), tokenGenerated: opts.token === undefined };
}

/** Close connections from addresses outside the allow list before any HTTP is read. */
export function dropForeignConnections(server: { on(event: "connection", cb: (s: { remoteAddress?: string; destroy(): void }) => void): unknown }, access?: NetworkAccess): void {
  if (!access) return;
  server.on("connection", (socket) => {
    if (!peerAllowed(access, socket.remoteAddress)) socket.destroy();
  });
}
