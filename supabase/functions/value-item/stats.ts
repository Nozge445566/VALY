// One copy of the small statistics helpers (spec 4.2 item 10). Pure, deterministic, no NaN for finite input.

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** q in [0,1] on an ALREADY SORTED ascending array, linear interpolation. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Weighted median (lower-half rule with midpoint on exact ties). Weights <= 0 are ignored. */
export function weightedMedian(xs: readonly number[], ws: readonly number[]): number {
  const p = xs.map((x, i) => [x, ws[i] ?? 0] as const).filter(([, w]) => w > 0 && Number.isFinite(w)).sort((a, b) => a[0] - b[0]);
  if (p.length === 0) return median(xs);
  const total = p.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i][1];
    if (acc > total / 2) return p[i][0];
    if (acc === total / 2) return (p[i][0] + p[i + 1][0]) / 2;
  }
  return p[p.length - 1][0];
}

/**
 * Huber M-estimator of location (precision weighted), fixed iteration count so it is deterministic.
 * `c` in units of the robust scale (MAD * 1.4826, floored).
 */
export function huber(xs: readonly number[], ws: readonly number[] | null = null, c = 1.345, iters = 20, scaleFloor = 0.05): number {
  if (xs.length === 0) return 0;
  const w0 = xs.map((_, i) => (ws && ws[i] > 0 ? ws[i] : ws ? 0 : 1));
  let mu = weightedMedian(xs, w0);
  const mad = Math.max(scaleFloor, median(xs.map((x) => Math.abs(x - mu)))) * 1.4826;
  for (let k = 0; k < iters; k++) {
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      const r = Math.abs(xs[i] - mu) / mad;
      const h = r <= c ? 1 : c / r;
      const w = w0[i] * h;
      num += w * xs[i];
      den += w;
    }
    if (den <= 0) break;
    const next = num / den;
    if (Math.abs(next - mu) < 1e-12) { mu = next; break; }
    mu = next;
  }
  return mu;
}
