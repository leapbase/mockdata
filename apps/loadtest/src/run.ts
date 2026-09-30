import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { parsePublicUrl } from "@mockdata/cli";
import { createAccounts, startServer } from "@mockdata/server";
import type { Mailer } from "@mockdata/auth-kit";
import { runLoadTest, type RampOptions, type RequestRecord, type StepStats } from "./kit/index.js";

const { values } = parseArgs({
  options: {
    scenarios: { type: "string", default: "session,login,generate" },
    users: { type: "string", default: "60" },
    "step-secs": { type: "string", default: "4" },
    rows: { type: "string", default: "20000" },
  },
});
const scenarios = new Set(values.scenarios!.split(","));
const userCount = Number(values.users);
const stepSecs = Number(values["step-secs"]);
const rows = Number(values.rows);
const PASSWORD = "L0ad$testPassw0rd";

const mailer: Mailer = { isConfigured: () => true, verifyConnection: async () => undefined, send: async () => undefined, isAuthError: () => false, formatError: String };

const dir = mkdtempSync(path.join(tmpdir(), "mockdata-loadtest-"));
const accounts = await createAccounts({
  publicUrl: parsePublicUrl("http://localhost:4747"),
  dataDir: path.join(dir, "data"),
  configRoot: dir,
  env: {},
  mailer,
  trustProxy: true, // lets each request claim its own address, so the per-address limiters see many visitors
  enumerationTimingFloorMs: 0,
  limits: { maxRows: 1_000_000, maxCells: 10_000_000, llmDailyRows: 1_000_000, llmGlobalDailyRows: 1_000_000 },
});
// Measure capacity, not the limiters: a virtual user is far faster than a person.
for (const limiter of Object.values(accounts.limiters)) {
  limiter.hit = () => true;
  limiter.isLimited = () => false;
}
const { server, url } = await startServer({ accounts, root: dir, port: 0, env: {} });

console.log(`mockdata load test against ${url} (real SQLite file, real password hashing, ${userCount} seeded users, ${process.version})`);
const seedStart = Date.now();
const cookies: string[] = [];
const emails: string[] = [];
await Promise.all(
  Array.from({ length: userCount }, async (_, i) => {
    const email = `user${i}@example.com`;
    const user = await accounts.auth.register({ email, password: PASSWORD });
    await accounts.auth.markEmailVerified(user.id);
    const session = await accounts.sessions.create(user.id);
    emails[i] = email;
    cookies[i] = `mockdata_session=${session.id}`;
  }),
);
console.log(`seeded ${userCount} users in ${Date.now() - seedStart} ms (this includes ${userCount} password hashes)`);

let n = 0;
const nextUser = () => n++ % userCount;
let ipCounter = 0;
const freshAddress = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

async function timed(make: () => Promise<Response>): Promise<RequestRecord[]> {
  const t = performance.now();
  try {
    const res = await make();
    await res.arrayBuffer();
    return [{ latencyMs: performance.now() - t, ok: res.status < 400, status: res.status }];
  } catch {
    return [{ latencyMs: performance.now() - t, ok: false, status: 0 }];
  }
}

const SCHEMA = (r: number) => `seed: 1
tables:
  people:
    rows: ${r}
    columns:
      id: { type: integer, primaryKey: true }
      name: { type: string, faker: person.fullName }
      city: { type: string, faker: location.city }
      born: { type: date, min: "1950-01-01", max: "2005-12-31" }
      score: { type: float, min: 0, max: 100 }
      tier: { type: string, enum: [a, b, c] }
`;

interface Scenario {
  label: string;
  note: string;
  request: () => Promise<RequestRecord[]>;
  ramp: Pick<RampOptions, "startConcurrency" | "stepSize" | "maxConcurrency">;
  /** Also measure how long a light request takes to be answered while this load runs. */
  probe?: boolean;
}

const all: Record<string, Scenario> = {
  session: {
    label: "Scenario: signed-in page load (GET /api/files with a session cookie)",
    note: "Each request checks the session in SQLite, opens the user's folder and lists it.",
    request: () => {
      const cookie = cookies[nextUser()]!;
      return timed(() => fetch(`${url}/api/files`, { headers: { cookie } }));
    },
    ramp: { startConcurrency: 4, stepSize: 12, maxConcurrency: 100 },
  },
  login: {
    label: "Scenario: sign-in (POST /api/auth/login, correct password, every request from a new address)",
    note: "Each one hashes a password (two at once, a queue of 16, then 503 'busy').",
    request: () => {
      const email = emails[nextUser()]!;
      return timed(() => fetch(`${url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() }, body: JSON.stringify({ email, password: PASSWORD }) }));
    },
    ramp: { startConcurrency: 2, stepSize: 4, maxConcurrency: 40 },
  },
  generate: {
    label: `Scenario: preview generation (POST /api/generate, ${rows} rows x 6 columns)`,
    note: "CPU work on the single event loop. The probe row shows how long a trivial request waits meanwhile.",
    request: () => {
      const cookie = cookies[nextUser()]!;
      return timed(() => fetch(`${url}/api/generate`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ text: SCHEMA(rows), previewRows: 5 }) }));
    },
    ramp: { startConcurrency: 1, stepSize: 1, maxConcurrency: 10 },
    probe: true,
  },
};

const summary: string[] = [];
for (const name of ["session", "login", "generate"]) {
  const s = all[name]!;
  if (!scenarios.has(name)) continue;
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  let probeRecords: number[] = [];
  let probing = !!s.probe;
  const probeLoop = (async () => {
    while (probing) {
      const t = performance.now();
      await fetch(`${url}/api/auth/me`).then((r) => r.arrayBuffer()).catch(() => undefined);
      probeRecords.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : 0);
  const result = await runLoadTest(s.request, {
    label: s.label,
    note: s.note,
    ...s.ramp,
    stepDurationSecs: stepSecs,
    maxErrorRate: 1,
    maxP95Ms: name === "generate" ? 5000 : 1500,
    onStep: (step: StepStats) => {
      if (!s.probe) return;
      console.log(`               probe (GET /api/auth/me during this step): P50 ${Math.round(pct(probeRecords, 0.5))}ms  P95 ${Math.round(pct(probeRecords, 0.95))}ms  worst ${Math.round(Math.max(0, ...probeRecords))}ms  (${step.concurrency} generating)`);
      probeRecords = [];
    },
  });
  probing = false;
  await probeLoop;
  delay.disable();
  const stall = `event-loop delay P99 ${(delay.percentile(99) / 1e6).toFixed(0)}ms, worst ${(delay.max / 1e6).toFixed(0)}ms`;
  console.log(`  ${stall}; memory ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  const last = result.lastStable;
  summary.push(`${name.padEnd(9)} max stable concurrency ${String(result.maxStableConcurrency ?? "none").padEnd(5)} ${last ? `(${last.reqPerSec} req/s, P95 ${last.p95}ms)` : ""}  ${stall}`);
}

console.log("\nSummary\n" + summary.join("\n"));
server.closeAllConnections();
await new Promise((r) => server.close(r));
accounts.close();
rmSync(dir, { recursive: true, force: true });
