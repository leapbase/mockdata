import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Environment for provider and connection settings: variables from ./.env,
 * overridden by the real environment. Error messages must name variables only,
 * never print values.
 */
export function loadEnv(cwd: string, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const file = join(cwd, ".env");
  const dotenv = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return { ...dotenv, ...base };
}
