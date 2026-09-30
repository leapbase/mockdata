import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@mockdata/core": src("core"),
      "@mockdata/llm": src("llm"),
      "@mockdata/cli": fileURLToPath(new URL("./packages/cli/src/cli.ts", import.meta.url)),
    },
  },
});
