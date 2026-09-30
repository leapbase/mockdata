import { describe, it, expect } from 'vitest';
import { runLoadTest } from '../src/kit/runner.js';

const baseOptions = {
  startConcurrency: 2,
  stepSize: 2,
  stepDurationSecs: 0.05,
  maxErrorRate: 5,
  maxP95Ms: 1000,
  maxConcurrency: 4,
  silent: true,
};

// A real fetch has network latency that naturally caps how many requests a
// tight VU loop can fire per second. Without that delay the fake loop below
// would spin as fast as the CPU allows and exhaust memory, so this mirrors
// that latency floor instead of resolving instantly.
function delayed(record: { latencyMs: number; ok: boolean; status: number }) {
  return new Promise<[typeof record]>((resolve) => setTimeout(() => resolve([record]), 1));
}

describe('runLoadTest', () => {
  it('ramps through all steps and reports the last one when everything stays under threshold', async () => {
    const result = await runLoadTest(
      () => delayed({ latencyMs: 1, ok: true, status: 200 }),
      baseOptions,
    );

    expect(result.steps.map((s) => s.concurrency)).toEqual([2, 4]);
    expect(result.steps.every((s) => s.stable)).toBe(true);
    expect(result.maxStableConcurrency).toBe(4);
    expect(result.lastStable?.concurrency).toBe(4);
  });

  it('stops at the first step and reports no stable concurrency once the error rate threshold is crossed', async () => {
    const result = await runLoadTest(
      () => delayed({ latencyMs: 1, ok: false, status: 500 }),
      baseOptions,
    );

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.stable).toBe(false);
    expect(result.steps[0]!.failReason).toBe('error rate exceeded');
    expect(result.maxStableConcurrency).toBeNull();
    expect(result.lastStable).toBeNull();
  });

  it('calls onStep for every completed step', async () => {
    const seen: number[] = [];
    await runLoadTest(
      () => delayed({ latencyMs: 1, ok: true, status: 200 }),
      { ...baseOptions, onStep: (step) => seen.push(step.concurrency) },
    );

    expect(seen).toEqual([2, 4]);
  });
});
