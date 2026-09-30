import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the UI runs on Vite's port and proxies the API to `mockdata-ui` (default port 4747).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:4747" } },
  build: { outDir: "dist" },
});
