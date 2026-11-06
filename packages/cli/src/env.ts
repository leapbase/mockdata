import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Environment for provider and connection settings: variables from ./.env,
 * overridden by the real environment. Error messages must name variables only,
 * never print values.
 *
 * The parsed .env is memoised per file, keyed by path and invalidated when
 * the file's mtime or size changes, so a request does not re-read and
 * re-parse it from disk on every call. The cache is bounded (oldest entry
 * evicted first).
 */
const MAX_ENV_CACHE_ENTRIES = 64;
const envCache = new Map<string, { mtimeMs: number; size: number; parsed: Record<string, string | undefined> }>();

export function loadEnv(cwd: string, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const file = join(cwd, ".env");
  let dotenv: Record<string, string | undefined> = {};
  try {
    const st = statSync(file);
    const hit = envCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      dotenv = hit.parsed;
    } else {
      const parsed = parseEnv(readFileSync(file, "utf8"));
      envCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
      if (envCache.size > MAX_ENV_CACHE_ENTRIES) envCache.delete(envCache.keys().next().value!);
      dotenv = parsed;
    }
  } catch {
    envCache.delete(file);
  }
  return { ...dotenv, ...base };
}
