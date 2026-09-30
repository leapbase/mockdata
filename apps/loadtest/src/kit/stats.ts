import type { RequestRecord } from './types.js';

export function computeStats(
  records: RequestRecord[],
  durationSecs: number,
): { reqPerSec: number; p50: number; p95: number; p99: number; errorRate: number; errorCodes: Record<string, number> } {
  if (records.length === 0) return { reqPerSec: 0, p50: 0, p95: 0, p99: 0, errorRate: 0, errorCodes: {} };
  const sorted = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const pct = (p: number) => Math.round(sorted[Math.floor((sorted.length - 1) * p)] ?? sorted[sorted.length - 1]!);
  const failed = records.filter((r) => !r.ok);
  const errorCodes: Record<string, number> = {};
  for (const r of failed) {
    const key = r.status === 0 ? 'network error' : String(r.status);
    errorCodes[key] = (errorCodes[key] ?? 0) + 1;
  }
  return {
    reqPerSec: Math.round(records.length / durationSecs),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    errorRate: Number(((failed.length / records.length) * 100).toFixed(1)),
    errorCodes,
  };
}
