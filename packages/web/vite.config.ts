import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the UI runs on Vite's port and proxies the API to `mockdata-ui` (default port 8000).
export default defineConfig({
  plugins: [react()],
  // Preserve the browser's Host so the backend can verify it matches Origin.
  server: { port: 3000, proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } } },
  build: {
    outDir: "dist",
    manifest: true,
    // Fonts stay files: the server's CSP has no font-src, so a small font inlined as a data: URL would be blocked.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
});
