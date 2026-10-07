import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { mockdataAliases } from "./vitest.aliases.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  esbuild: { jsx: "automatic" },
  // Several files start real servers, threads and model stand-ins at once; the 5 s default is too tight on a busy machine.
  test: { testTimeout: 20_000, hookTimeout: 20_000, setupFiles: ["./vitest.setup.ts"] },
  resolve: {
    alias: {
      ...mockdataAliases(root),
      "@mockdata/auth-kit": src("auth-kit"),
      "@mockdata/accounts": src("accounts"),
    },
  },
});
