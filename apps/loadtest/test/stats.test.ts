import { describe, it, expect } from 'vitest';
import { computeStats } from '../src/kit/stats.js';

describe('computeStats', () => {
  it('returns zeros for empty records', () => {
    expect(computeStats([], 10)).toEqual({
      reqPerSec: 0, p50: 0, p95: 0, p99: 0, errorRate: 0, errorCodes: {},
    });
  });

  it('computes percentiles from sorted latencies', () => {
    // 100 records: latencies 1..100ms, all ok
    const records = Array.from({ length: 100 }, (_, i) => ({
      latencyMs: i + 1,
      ok: true,
      status: 200,
    }));
    const stats = computeStats(records, 10);
    expect(stats.p50).toBe(50);   // index 49 (Math.floor(99 * 0.50)) → value 50
    expect(stats.p95).toBe(95);   // index 94 (Math.floor(99 * 0.95)) → value 95
    expect(stats.p99).toBe(99);   // index 98 (Math.floor(99 * 0.99)) → value 99
    expect(stats.errorRate).toBe(0);
    expect(stats.reqPerSec).toBe(10); // 100 req / 10s
  });

  it('computes error rate and error codes correctly', () => {
    const records = [
      { latencyMs: 100, ok: true,  status: 200 },
      { latencyMs: 200, ok: false, status: 429 },
      { latencyMs: 150, ok: true,  status: 200 },
      { latencyMs: 300, ok: false, status: 429 },
    ];
    const stats = computeStats(records, 1);
    expect(stats.errorRate).toBe(50);
    expect(stats.errorCodes).toEqual({ '429': 2 });
  });

  it('rounds reqPerSec to nearest integer', () => {
    const records = Array.from({ length: 7 }, () => ({ latencyMs: 50, ok: true, status: 200 }));
    const stats = computeStats(records, 3);
    expect(stats.reqPerSec).toBe(2); // Math.round(7/3) = 2
  });
});
