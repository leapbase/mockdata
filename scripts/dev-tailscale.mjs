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

function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
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

start(["packages/server/dist/bin.js", "examples", "--allow", "100.100.1.0/24"]);
start([
  vite,
  "--host", "100.100.1.17", "--port", "3001", "--strictPort",
], fileURLToPath(new URL("../packages/web/", import.meta.url)));
