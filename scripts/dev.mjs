import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vite = fileURLToPath(new URL("bin/vite.js", import.meta.resolve("vite/package.json")));
const children = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  timeout.unref();
}

function start(args, cwd = root, env = {}) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  children.add(child);
  child.on("error", (error) => {
    console.error(error.message);
    children.delete(child);
    stop(1);
  });
  child.on("exit", (code) => {
    children.delete(child);
    stop(code ?? 1);
  });
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

// UI on Vite's default port (3000); the API listens 5 above it and Vite proxies /api there. Localhost only.
const uiPort = 3000;
const apiPort = uiPort + 5;

start(["packages/server/dist/bin.js", "examples", "--port", String(apiPort)]);
start([vite, "--port", String(uiPort)], fileURLToPath(new URL("../packages/web/", import.meta.url)), {
  MOCKDATA_API_PORT: String(apiPort),
});
