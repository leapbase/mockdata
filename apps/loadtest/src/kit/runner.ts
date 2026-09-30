import { computeStats } from './stats.js';
import type { LoadTestResult, RampOptions, RequestRecord, StepStats, VirtualUserRequest } from './types.js';

const DEFAULT_MAX_CONCURRENCY = 500;

function ms(n: number): string {
  return `${n.toLocaleString()}ms`;
}

function printHeader(options: RampOptions): void {
  if (options.silent) return;
  if (options.label) console.log(`\n${options.label}`);
  console.log(`Step: +${options.stepSize} users / ${options.stepDurationSecs}s  |  Thresholds: error rate > ${options.maxErrorRate}%  |  P95 > ${options.maxP95Ms}ms`);
  if (options.note) console.log(`${options.note}\n`);
  console.log('Concurrency   Req/s   P50      P95      P99      Errors   Status');
  console.log('─'.repeat(67));
}

function printStepRow(step: StepStats, silent?: boolean): void {
  if (silent) return;
  const status = step.stable ? '✓ stable' : `✗ ${step.failReason ?? 'threshold exceeded'}`;
  const cols = [
    String(step.concurrency).padEnd(14),
    String(step.reqPerSec).padEnd(8),
    ms(step.p50).padEnd(9),
    ms(step.p95).padEnd(9),
    ms(step.p99).padEnd(9),
    `${step.errorRate.toFixed(1)}%`.padEnd(9),
    status,
  ];
  console.log(cols.join(''));
  if (!step.stable && Object.keys(step.errorCodes).length > 0) {
    const summary = Object.entries(step.errorCodes)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code} ×${count}`)
      .join('  ');
    console.log(`               Errors: ${summary}`);
  }
}

function sleep(msToWait: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msToWait));
}

/**
 * Step-ramp load test: starts `startConcurrency` virtual users each calling
 * `makeRequest()` in a tight loop, holds each step for `stepDurationSecs`,
 * then adds `stepSize` more users — until error rate or P95 latency crosses
 * the configured threshold. Returns the last step that stayed within
 * thresholds (`lastStable`) along with every step's stats.
 */
export async function runLoadTest(makeRequest: VirtualUserRequest, options: RampOptions): Promise<LoadTestResult> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  printHeader(options);

  const records: RequestRecord[] = [];
  let running = true;

  async function virtualUser(): Promise<void> {
    while (running) {
      records.push(...(await makeRequest()));
    }
  }

  const vus: Promise<void>[] = [];
  let concurrency = options.startConcurrency;
  for (let i = 0; i < concurrency; i++) vus.push(virtualUser());

  const steps: StepStats[] = [];
  let lastStable: StepStats | null = null;

  while (concurrency <= maxConcurrency) {
    await sleep(options.stepDurationSecs * 1000);
    const snapshot = records.splice(0);
    if (snapshot.length === 0) {
      if (!options.silent) console.log('  (no requests completed in this window — target may be unresponsive)');
      break;
    }
    const raw = computeStats(snapshot, options.stepDurationSecs);
    const exceeded = raw.errorRate > options.maxErrorRate || raw.p95 > options.maxP95Ms;
    const failReason = !exceeded
      ? undefined
      : raw.p95 > options.maxP95Ms && raw.errorRate > options.maxErrorRate
        ? 'P95 + error rate exceeded'
        : raw.p95 > options.maxP95Ms
          ? 'P95 exceeded'
          : 'error rate exceeded';

    const step: StepStats = { concurrency, ...raw, stable: !exceeded, failReason };
    steps.push(step);
    options.onStep?.(step);
    printStepRow(step, options.silent);

    if (exceeded) break;

    lastStable = step;
    concurrency += options.stepSize;
    if (concurrency > maxConcurrency) break;

    for (let i = 0; i < options.stepSize; i++) vus.push(virtualUser());
  }

  running = false;
  await Promise.allSettled(vus);

  if (!options.silent) {
    console.log('');
    if (lastStable === null) {
      console.log(`Target already degraded at minimum concurrency (${options.startConcurrency}).`);
    } else {
      console.log(`→ Max stable concurrent users: ${lastStable.concurrency}`);
      console.log(
        `  Last stable step: P50 ${ms(lastStable.p50)}  P95 ${ms(lastStable.p95)}` +
        `  Req/s ${lastStable.reqPerSec}  Errors ${lastStable.errorRate.toFixed(1)}%`,
      );
    }
  }

  return { maxStableConcurrency: lastStable?.concurrency ?? null, lastStable, steps };
}
