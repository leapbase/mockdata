export type RequestRecord = { latencyMs: number; ok: boolean; status: number };

export interface StepStats {
  concurrency: number;
  reqPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  errorCodes: Record<string, number>;
  stable: boolean;
  failReason?: string;
}

export interface LoadTestResult {
  maxStableConcurrency: number | null;
  lastStable: StepStats | null;
  steps: StepStats[];
}

/**
 * One virtual user's unit of work for a step. The host owns everything
 * about what a request is (auth headers, endpoints, payloads) — this
 * package only measures the RequestRecords it returns.
 */
export type VirtualUserRequest = () => Promise<RequestRecord[]>;

export interface RampOptions {
  /** Printed as the run's header line(s); may contain '\n'. Omit for no header. */
  label?: string;
  /** Printed after the thresholds line, before the results table starts. */
  note?: string;
  startConcurrency: number;
  stepSize: number;
  stepDurationSecs: number;
  maxErrorRate: number;
  maxP95Ms: number;
  /** Hard ceiling on concurrency the ramp will reach. Default 500. */
  maxConcurrency?: number;
  /** Suppress all console output. */
  silent?: boolean;
  onStep?: (step: StepStats) => void;
}
