/**
 * Small summary statistics shared by the dwell maths and the query engine.
 *
 * Extracted so `domain/query` does not have to import `domain/request` — the
 * query engine is generic over note types and must not depend on any one of
 * them.
 *
 * Pure module: no Obsidian, no Node.
 */

/**
 * Linear-interpolated percentile, the definition R's `quantile(type = 7)` and
 * NumPy's default use.
 *
 * Named here rather than left implicit because "the 90th percentile" is not one
 * number — there are nine standard definitions and they disagree on small
 * samples, which is exactly the size of sample a request queue produces.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(Math.max(p, 0), 1);
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}

/** Median of a list, or null when empty. Even counts take the mean of the middle pair. */
export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** One bucket of a histogram: `[min, max)` in whatever unit the caller uses. */
export interface Bucket {
  label: string;
  /** Inclusive lower bound. */
  min: number;
  /** Exclusive upper bound; null means "and above". */
  max: number | null;
}

export interface BucketCount extends Bucket {
  count: number;
}

/**
 * Count values into fixed buckets.
 *
 * Fixed rather than computed: a distribution whose bucket edges move as the
 * data changes cannot be compared against last month's, which is the only
 * reason anyone looks at one. Empty buckets are kept — a gap in the middle of
 * a distribution is information, and dropping it redraws the shape.
 *
 * A value below the first bucket or above the last is not counted, and the
 * caller gets the total back so it can state its own denominator (§6).
 */
export function histogram(
  values: readonly number[],
  buckets: readonly Bucket[],
): { counts: BucketCount[]; counted: number } {
  const counts: BucketCount[] = buckets.map((bucket) => ({ ...bucket, count: 0 }));
  let counted = 0;
  for (const value of values) {
    for (const bucket of counts) {
      if (value >= bucket.min && (bucket.max === null || value < bucket.max)) {
        bucket.count++;
        counted++;
        break;
      }
    }
  }
  return { counts, counted };
}
