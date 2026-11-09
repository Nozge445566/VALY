// Nightly calibration fit. Pure: no network, no randomness. Turns (bucket, stored interval recipe, real selling price)
// into one width multiplier k per bucket, so the 80 percent range really contains the price about 8 times out of 10.
// The replay and the conformal quantile live in value-item/backtest.ts (the same code the backtest script uses).
import { conformalK, replayStored, score } from "../value-item/backtest.ts";
import type { BacktestRecord } from "../value-item/backtest.ts";
import { parentOf } from "./calibration.ts";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const K_FLOOR = 0.6; // table CHECK: k between 0.6 and 2.5
export const K_CEIL = 2.5;
export const MIN_BUCKET_N = 30; // below this a bucket gets no row of its own and uses its parent
export const SHRINK_N = 60; // a bucket reaches full weight at this many records; before that it is pulled toward its parent
// Adaptive update (replaces the fixed 0.25 per-night cap, owner: "slow correction, make it more impacting, optimised"):
// the more evidence a bucket has, the more of the gap to the fitted k is closed in ONE night, and the larger the allowed jump.
export const MOVE_BASE = 0.25; // allowed jump with almost no data
export const MOVE_MAX = 1.5; // allowed jump with lots of data (still inside the table's [0.6, 2.5])
export const MOVE_FULL_N = 150; // n at which the full MOVE_MAX is allowed
export const BLEND_N0 = 40; // alpha = n / (n + BLEND_N0): n=40 -> 0.5, n=120 -> 0.75, n=360 -> 0.9
export const BLEND_MIN = 0.4;
export const BLEND_MAX = 0.95;
/** Largest |k_new - k_prev| allowed tonight for a bucket with n records. */
export const moveLimit = (n: number) => MOVE_BASE + (MOVE_MAX - MOVE_BASE) * clamp(n / MOVE_FULL_N, 0, 1);
/** Share of the gap (fitted - previous) closed tonight. Few records: careful; many records: nearly all at once. */
export const blendAlpha = (n: number) => clamp(n / (n + BLEND_N0), BLEND_MIN, BLEND_MAX);

export interface FitRecord extends BacktestRecord { bucket: string }
export interface FitRow { bucket: string; k: number; n: number; coverage: number }
// Follow-ups (owner 1n.B). (a) If the coverage measured after LAST night's write is outside this band and the bucket has >= FULL_JUMP_N
// records, tonight closes the whole gap (alpha 1, full move limit). (b) Drift guard: if the last DRIFT_MIN_MOVES nightly moves of a
// bucket alternate up/down, alpha is halved (the correction is oscillating, not converging).
export const COVERAGE_OK_LOW = 0.74;
export const COVERAGE_OK_HIGH = 0.86;
export const FULL_JUMP_N = 100;
export const DRIFT_MIN_MOVES = 4;
export const DRIFT_ALPHA_FACTOR = 0.5;
export interface FitOptions {
  /** coverage written last night per bucket (l_calibration.coverage) */
  previousCoverage?: ReadonlyMap<string, number>;
  /** last k values per bucket, oldest first (l_calibration_history) */
  history?: ReadonlyMap<string, readonly number[]>;
}
/** True when the last `DRIFT_MIN_MOVES` moves (needs that many + 1 values) strictly alternate in direction by a visible amount. */
export function isOscillating(ks: readonly number[] | undefined): boolean {
  if (!ks || ks.length < DRIFT_MIN_MOVES + 1) return false;
  const tail = ks.slice(-(DRIFT_MIN_MOVES + 1));
  let prev = 0;
  for (let i = 1; i < tail.length; i++) {
    const d = tail[i] - tail[i - 1];
    if (!Number.isFinite(d) || Math.abs(d) < 0.02) return false;
    const sgn = Math.sign(d);
    if (prev !== 0 && sgn === prev) return false;
    prev = sgn;
  }
  return true;
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** The bucket a stored run was calibrated under (written by the engine in steps.interval.bucket). Garbage -> null (record unused). */
export function bucketOfStored(stored: { bucket?: unknown } | null | undefined): string | null {
  const b = stored?.bucket;
  return typeof b === "string" && b.length > 0 && b.length <= 120 && !/[\s]/.test(b) ? b : null;
}

/**
 * Rows to write. `previous` = the k values of the table now (for the nightly move limit).
 * Each bucket with >= MIN_BUCKET_N records gets its conformal k, shrunk toward its parent's fit when n < SHRINK_N, clamped to
 * [K_FLOOR, K_CEIL] and to previous +- MAX_NIGHTLY_MOVE. A parent's fit is the pooled fit of all its children's records.
 * No data -> no rows (never writes defaults).
 */
export function fitCalibration(records: FitRecord[], previous: ReadonlyMap<string, number> = new Map(), target = 0.8, opts: FitOptions = {}): FitRow[] {
  const usable = records.filter((r) => fin(r.truthUsd) && r.truthUsd > 0 && r.bucket);
  const groups = new Map<string, FitRecord[]>();
  for (const r of usable) {
    // each record counts for its bucket and every ancestor, so a thin bucket can borrow from a thick parent
    for (let b: string | null = r.bucket; b !== null; b = parentOf(b)) {
      const g = groups.get(b) ?? [];
      g.push(r);
      groups.set(b, g);
    }
  }
  const raw = new Map<string, { k: number; n: number }>();
  for (const [b, g] of groups) {
    if (g.length < MIN_BUCKET_N) continue;
    const k = conformalK(g, target, MIN_BUCKET_N);
    if (k !== null && fin(k)) raw.set(b, { k, n: g.length });
  }
  const rows: FitRow[] = [];
  for (const [b, { k, n }] of raw) {
    const parent = parentOf(b);
    const pk = parent !== null ? raw.get(parent)?.k : undefined;
    const w = clamp(n / SHRINK_N, 0, 1);
    let kk = pk !== undefined && b !== "global" ? w * k + (1 - w) * pk : k;
    const prev = previous.get(b);
    if (fin(prev)) {
      let alpha = blendAlpha(n);
      let lim = moveLimit(n);
      const pc = opts.previousCoverage?.get(b);
      if (fin(pc) && n >= FULL_JUMP_N && (pc < COVERAGE_OK_LOW || pc > COVERAGE_OK_HIGH)) { alpha = 1; lim = MOVE_MAX; }
      else if (isOscillating(opts.history?.get(b))) alpha *= DRIFT_ALPHA_FACTOR;
      kk = prev + alpha * (kk - prev);
      kk = clamp(kk, prev - lim, prev + lim);
    }
    kk = clamp(kk, K_FLOOR, K_CEIL);
    // coverage is measured WITH the k that will be written, on the bucket's own records
    const g = groups.get(b)!;
    const cov = score(g, () => ({ k: kk })).coverage;
    rows.push({ bucket: b, k: Math.round(kk * 1000) / 1000, n, coverage: Math.round(cov * 1000) / 1000 });
  }
  return rows.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export { replayStored };
