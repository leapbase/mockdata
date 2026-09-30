import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@mockdata/core": src("core"),
      "@mockdata/llm": src("llm"),
      "@mockdata/auth-kit": src("auth-kit"),
      "@mockdata/accounts": src("accounts"),
      "@mockdata/inputs": src("inputs"),
      "@mockdata/cli": fileURLToPath(new URL("./packages/cli/src/cli.ts", import.meta.url)),
    },
  },
});
