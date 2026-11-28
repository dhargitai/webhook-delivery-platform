export interface LatencySummary {
  count: number;
  /** In ms; `null` when nothing was measured. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/**
 * Nearest-rank percentiles: the value at rank ceil(p/100 * n) of the sorted
 * sample. Always a measured value, never an interpolated one, so a reported
 * p99 is a latency that really happened.
 */
export function summarize(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
  return {
    count: sorted.length,
    p50: rank(50),
    p95: rank(95),
    p99: rank(99),
    max: sorted[sorted.length - 1] ?? null,
  };
}
