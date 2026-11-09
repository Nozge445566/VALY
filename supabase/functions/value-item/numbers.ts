// Small number helpers. Pure functions, no network.

import type { Grade } from "./types.ts";
import { median as statsMedian, quantile as statsQuantile } from "./stats.ts";

/** Unsorted-input wrappers over the single implementation in stats.ts (non-finite values dropped, empty list -> 0). */
export function median(xs: number[]): number {
  return statsMedian(xs.filter((x) => Number.isFinite(x)));
}

/** Quantile with linear interpolation. q is 0..1. Returns 0 for an empty list. */
export function quantile(xs: number[], q: number): number {
  return statsQuantile(xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b), q);
}

const GRADE_SCORE: Record<Grade, number> = { "new": 0.95, "like-new": 0.82, "good": 0.65, "fair": 0.48, "poor": 0.3 };
export function conditionScore(g: Grade): number {
  return GRADE_SCORE[g];
}

export function confidenceLabel(score: number): "low" | "medium" | "high" {
  return score >= 70 ? "high" : score >= 45 ? "medium" : "low";
}

/** The rounding step for an amount, so the app never shows false precision. */
export function niceStep(n: number): number {
  return n < 100 ? 1 : n < 1000 ? 5 : n < 10_000 ? 10 : n < 100_000 ? 100 : 1000;
}

// ---- Rounding in the USER'S currency (every currency is supported). The USD step table above assumes dollar-like magnitudes;
// 25 KWD, 25 000 VND and 0.5 BTC-like values need their own steps. `decimals` = ISO 4217 minor units of the currency.
export function niceStepLocal(n: number, decimals: number): number {
  const minStep = 10 ** -Math.max(0, Math.min(3, decimals));
  const step = n < 2 ? 0.05 : n < 5 ? 0.1 : n < 20 ? 0.5 : n < 100 ? 1 : niceStep(n);
  return Math.max(minStep, minStep >= 1 ? Math.max(1, step) : step);
}
const fix = (x: number, decimals: number) => Math.round(x * 10 ** decimals) / 10 ** decimals;
export function roundLocal(n: number, decimals: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = niceStepLocal(n, decimals);
  return fix(Math.max(step, Math.round(n / step) * step), decimals);
}
export function floorLocal(n: number, decimals: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = niceStepLocal(n, decimals);
  const f = Math.floor(n / step + 1e-9) * step;
  return f > 0 ? fix(f, decimals) : fix(n, decimals);
}
export function ceilLocal(n: number, decimals: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = niceStepLocal(n, decimals);
  return fix(Math.ceil(n / step - 1e-9) * step, decimals);
}
