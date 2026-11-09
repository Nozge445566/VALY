// Nightly fit of the Judge band tables. Pure: no network, no randomness.
// The stored recipe (l_runs.steps.interval.comps) already carries every ad's price (brought to the photo item by math.ts) and the
// Judge's bands, so NO separate l_judge_log table is needed: join l_runs to l_feedback and read the comps.
// Residual of one ad = ln(truth) - ln(ad price). Method (robust, shrunk, bounded):
//  * p_same bands: ln-variance = squared scaled MAD of the residuals around the band's own median, shrunk toward the default row.
//  * relative_value bands: correction = exp(median(band) - median(equal)); new factor = default * correction (the stored price already
//    used the default factor), shrunk in ln space, bounded to the band's neighbours so the order can never invert.
// Output rows are the ONLY thing the runtime may apply, through applyAdCalibration (bounded, ordered, finite).
import { P_SAME_SE2, RELATIVE_BANDS, RELATIVE_FACTOR, RELATIVE_SE2, type PSameBand, type RelativeBand } from "../value-item/ad-calibration.ts";
import { median } from "../value-item/stats.ts";

export const MIN_BAND_N = 40; // records (ads) a band needs before it gets a row
export const SHRINK_BAND_N = 120; // full weight at this many
export const MAX_REL_MOVE_LN = 0.12; // a factor never moves more than this in ln per night
export const SE2_MIN = 0.005;
export const SE2_MAX = 0.5;

export interface FitComp { priceUsd: number; pSame?: string; relative?: string }
export interface JudgeFitRecord { truthUsd: number; comps: FitComp[] }
export interface JudgeRow { kind: "p_same" | "relative_factor"; band: string; value: number; n: number }

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const scaledMad = (xs: number[], m: number) => 1.4826 * median(xs.map((x) => Math.abs(x - m)));

export function fitJudgeBands(records: readonly JudgeFitRecord[]): JudgeRow[] {
  const bySame = new Map<string, number[]>();
  const byRel = new Map<string, number[]>();
  for (const r of records) {
    if (!fin(r.truthUsd) || r.truthUsd <= 0 || !Array.isArray(r.comps)) continue;
    for (const c of r.comps) {
      if (!c || !fin(c.priceUsd) || c.priceUsd <= 0) continue;
      const res = Math.log(r.truthUsd) - Math.log(c.priceUsd);
      if (c.pSame && c.pSame in P_SAME_SE2 && c.pSame !== "no") (bySame.get(c.pSame) ?? bySame.set(c.pSame, []).get(c.pSame)!).push(res);
      if (c.relative && (RELATIVE_BANDS as readonly string[]).includes(c.relative)) (byRel.get(c.relative) ?? byRel.set(c.relative, []).get(c.relative)!).push(res);
    }
  }
  const rows: JudgeRow[] = [];
  for (const [band, xs] of bySame) {
    if (xs.length < MIN_BAND_N) continue;
    const m = median(xs);
    const raw = scaledMad(xs, m) ** 2;
    const w = clamp(xs.length / SHRINK_BAND_N, 0, 1);
    const def = P_SAME_SE2[band as PSameBand];
    rows.push({ kind: "p_same", band, value: Math.round(clamp(w * raw + (1 - w) * def, SE2_MIN, SE2_MAX) * 1e4) / 1e4, n: xs.length });
  }
  const eq = byRel.get("equal");
  if (eq && eq.length >= MIN_BAND_N) {
    const base = median(eq);
    for (const band of RELATIVE_BANDS) {
      const xs = byRel.get(band);
      if (!xs || xs.length < MIN_BAND_N || band === "equal") continue;
      const w = clamp(xs.length / SHRINK_BAND_N, 0, 1);
      const corr = clamp(w * (median(xs) - base), -MAX_REL_MOVE_LN, MAX_REL_MOVE_LN);
      rows.push({ kind: "relative_factor", band, value: Math.round(RELATIVE_FACTOR[band] * Math.exp(corr) * 1e4) / 1e4, n: xs.length });
    }
  }
  return rows.sort((a, b) => (a.kind + a.band).localeCompare(b.kind + b.band));
}

/** The default tables, so a caller can show what a row replaces. */
export const DEFAULTS = { P_SAME_SE2, RELATIVE_FACTOR, RELATIVE_SE2 };

export interface AdCalibrationState { pSame: Partial<Record<PSameBand, number>>; relative: Partial<Record<RelativeBand, number>> }

/**
 * Safe override of the live tables. Bad rows are ignored; factors keep the 9-band order (strictly increasing) and the sign of
 * "worse < 1 < better"; se2 stays in [SE2_MIN, SE2_MAX] and the p_same order certain <= likely <= unsure <= unlikely is kept.
 * Returns what was applied. `resetAdCalibration` restores the defaults (used by tests).
 */
const DEFAULT_COPY = { p: { ...P_SAME_SE2 }, r: { ...RELATIVE_FACTOR } };
export function resetAdCalibration() { Object.assign(P_SAME_SE2, DEFAULT_COPY.p); Object.assign(RELATIVE_FACTOR, DEFAULT_COPY.r); }
export function applyAdCalibration(rows: readonly JudgeRow[]): AdCalibrationState {
  resetAdCalibration();
  const applied: AdCalibrationState = { pSame: {}, relative: {} };
  const order: PSameBand[] = ["certain", "likely", "unsure", "unlikely"];
  for (const r of rows) if (r && r.kind === "p_same" && order.includes(r.band as PSameBand) && fin(r.value) && r.value >= SE2_MIN && r.value <= SE2_MAX) P_SAME_SE2[r.band as PSameBand] = r.value;
  for (let i = 1; i < order.length; i++) if (P_SAME_SE2[order[i]] < P_SAME_SE2[order[i - 1]]) P_SAME_SE2[order[i]] = P_SAME_SE2[order[i - 1]];
  for (const r of rows) if (r && r.kind === "relative_factor" && (RELATIVE_BANDS as readonly string[]).includes(r.band) && r.band !== "equal" && fin(r.value) && r.value > 0.3 && r.value < 3) RELATIVE_FACTOR[r.band as RelativeBand] = r.value;
  const ei = RELATIVE_BANDS.indexOf("equal");
  for (let i = ei - 1; i >= 0; i--) RELATIVE_FACTOR[RELATIVE_BANDS[i]] = Math.min(RELATIVE_FACTOR[RELATIVE_BANDS[i]], (i + 1 === ei ? 0.995 : RELATIVE_FACTOR[RELATIVE_BANDS[i + 1]] - 0.005));
  for (let i = ei + 1; i < RELATIVE_BANDS.length; i++) RELATIVE_FACTOR[RELATIVE_BANDS[i]] = Math.max(RELATIVE_FACTOR[RELATIVE_BANDS[i]], (i - 1 === ei ? 1.005 : RELATIVE_FACTOR[RELATIVE_BANDS[i - 1]] + 0.005));
  for (const b of order) applied.pSame[b] = P_SAME_SE2[b];
  for (const b of RELATIVE_BANDS) applied.relative[b] = RELATIVE_FACTOR[b];
  return applied;
}
