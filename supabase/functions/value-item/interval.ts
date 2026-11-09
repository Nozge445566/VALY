// The interval engine.
//
// Pure, deterministic functions. No network, no randomness, no AI. All money is USD, all maths
// is on the natural logarithm of the price. Every constant lives in interval.config.ts.
//
// The interval is the central 80 percent range (10th to 90th percentile): the realistic selling
// price should fall inside it 8 times out of 10. Calibration (l_calibration) corrects the overall
// width through the multiplier `k`.

import * as C from "./interval.config.ts";
import type { FallbackLevel } from "./interval.config.ts";
import { LOCAL_SHARE_FOREIGN_BELOW } from "./market-tiers.ts";

export type { FallbackLevel } from "./interval.config.ts";

// ---------------------------------------------------------------- types

export type CompKind = "sold" | "asking";
export type CompMatch = "same" | "similar" | "unknown";

/** One priced listing, in USD, before any adjustment. */
export interface RawComp {
  priceUsd: number;
  kind: CompKind;
  /** What the Judge said about it. "unknown" when it did not say. */
  match?: CompMatch;
  /** JudgeReport v2 bands (optional, stored in the recipe so a backtest replays the same noise). */
  pSame?: "certain" | "likely" | "unsure" | "unlikely" | "no";
  reliability?: "high" | "normal" | "low";
  /** relative_value band of this ad (price is ALREADY brought to the photo item by math.ts); only adds a little variance. */
  relative?: "much_worse" | "clearly_worse" | "worse" | "slightly_worse" | "equal" | "slightly_better" | "better" | "clearly_better" | "much_better";
  /** Age of the listing in days, when the date is known. Otherwise leave it out. */
  ageDays?: number | null;
  /**
   * Where the listing came from compared with the user's country (market-tiers.ts). Left out means
   * "use the input's fallbackLevel", which is how results saved before country adaptation replay.
   */
  tier?: FallbackLevel;
  /** Country of the listing (ISO alpha-2). Saved so the nightly job can learn a price level per country pair. */
  origin?: string;
  /**
   * Learned price-level shift in ln price, ALREADY looked up for (origin -> user) by the caller
   * (pipeline.ts) and stored with the comparable, so a backtest replays exactly what ran. Omitted or 0 = none.
   * Only foreign comparables can carry one. The price in `priceUsd` stays the real, unshifted listing price.
   */
  shiftLn?: number;
  /** Learned noise (ln price) of this comparable's country pair. Only ever wider than FOREIGN_STD[tier]. */
  extraStd?: number;
}

export const WIDTH_DRIVERS = [
  "model_only",
  "few_comparables",
  "sources_disagree",
  "mostly_asking_prices",
  "rarity",
  "unclear_condition",
  "authenticity",
  "identity",
  "judge_disagreement",
] as const;
export type WidthDriver = (typeof WIDTH_DRIVERS)[number];

export type Strength = "none" | "thin" | "ok" | "rich";

export interface IntervalInput {
  /** Non-resale valuation mode (only set for retail/auction items). Adds an optional 4th bucket part; absent = resale, old key. */
  mode?: "retail" | "auction";
  /** Asking-to-sold factor for non-sold comps. Absent = ASKING_TO_SOLD (0.9), so old recipes replay identically. 1.0 for a new item in new condition. */
  askingToSold?: number;
  /** The Judge's own range, in USD. */
  model: { low: number; mid: number; high: number };
  /** The Judge's own confidence, 0-100. */
  modelConfidence: number;
  comps: RawComp[];
  category: string;
  condition: string;
  /** low | medium | high | unknown */
  authenticityRisk: string;
  unknownsCount: number;
  /** How many consistency rules fired (consistency.ts). Optional: old recipes replay as 0. */
  judgeDisagreements?: number;
  variantAmbiguity?: number;
  /** common | unknown | rare | very_rare. The Brain does not know this yet: leave it out. */
  rarity?: string;
  /** True when the exact model is uncertain. */
  identitySimilar?: boolean;
  fallbackLevel?: FallbackLevel;
  /** Mids of items the model itself named as similar (optional). */
  similarMids?: number[];
  /** Calibration multiplier for the width (section 6). Default 1. */
  k?: number;
  /** Looks k up by calibration bucket (category|strength). Wins over `k`. A missing bucket is 1. */
  kOf?: (bucket: string) => number | null | undefined;
  /** Model overconfidence multiplier. Default 1. */
  kM?: number;
  /** Prior spread of the category. Default: the measured value, else the config default. */
  sigmaCat?: number;
}

export interface IntervalBreakdown {
  mu: number;
  muM: number;
  muK: number | null;
  sK2: number | null;
  seK2: number | null;
  sM: number;
  tauC2: number | null;
  d: number | null;
  /** The share of the comparables from outside the user's country, and the std it adds. Zero when all are local. */
  foreignShare: number;
  foreignStd: number;
  /** Weighted mean of the learned price-level shifts applied to the comparables (ln price). 0 when none. */
  shiftLn: number;
  basis: EvidenceBasis;
  extras2: number;
  sLow2: number;
  sHigh2: number;
  df: number;
  t: number;
  k: number;
  bucket: string;
  n_eff: number;
  fallbackLevel: FallbackLevel;
  w: number;
}

export interface IntervalOutput {
  /** USD, unrounded. low < mid < high. */
  low: number;
  mid: number;
  high: number;
  /** 5-95. The only confidence score: it comes from the width. */
  confidenceScore: number;
  intervalLevel: typeof C.INTERVAL_LEVEL;
  widthDrivers: WidthDriver[];
  /** True when the range is wider than CAP_LOG_WIDTH. The numbers are not clipped. */
  needsMoreInfo: boolean;
  /** How much the market counted compared with the model, 0-1. 0 when there is no market. */
  marketWeight: number;
  breakdown: IntervalBreakdown;
}

// ---------------------------------------------------------------- small maths

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fin = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

/**
 * Weighted quantile with linear interpolation between the weighted midpoints of the sorted values.
 * With equal weights it equals the ordinary quantile. q is 0..1. Empty list: 0.
 */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const pairs: [number, number][] = [];
  for (let i = 0; i < values.length; i++) {
    const w = weights[i];
    if (Number.isFinite(values[i]) && Number.isFinite(w) && w > 0) pairs.push([values[i], w]);
  }
  if (pairs.length === 0) return 0;
  if (pairs.length === 1) return pairs[0][0];
  pairs.sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((s, p) => s + p[1], 0);
  const mids: number[] = [];
  let run = 0;
  for (const p of pairs) {
    mids.push((run + p[1] / 2) / total);
    run += p[1];
  }
  const qq = clamp(q, 0, 1);
  if (qq <= mids[0]) return pairs[0][0];
  if (qq >= mids[mids.length - 1]) return pairs[pairs.length - 1][0];
  for (let i = 1; i < mids.length; i++) {
    if (qq <= mids[i]) {
      const span = mids[i] - mids[i - 1];
      const f = span > 0 ? (qq - mids[i - 1]) / span : 0;
      return pairs[i - 1][0] + (pairs[i][0] - pairs[i - 1][0]) * f;
    }
  }
  return pairs[pairs.length - 1][0];
}

export function weightedMedian(values: number[], weights: number[]): number {
  return weightedQuantile(values, weights, 0.5);
}

/** Student t, 90th percentile. Table lookup, linear in 1/df. */
export function t90(df: number): number {
  const tab = C.T90_TABLE;
  const d = fin(df, 5);
  if (d <= tab[0][0]) return tab[0][1];
  if (d >= tab[tab.length - 1][0]) return tab[tab.length - 1][1];
  for (let i = 1; i < tab.length; i++) {
    if (d <= tab[i][0]) {
      const [d0, t0] = tab[i - 1];
      const [d1, t1] = tab[i];
      const x0 = 1 / d0;
      const x1 = 1 / d1;
      const f = (1 / d - x0) / (x1 - x0);
      return t0 + (t1 - t0) * f;
    }
  }
  return tab[tab.length - 1][1];
}

/** The confidence score for a log width. One source of truth (4H). */
export function scoreFromWidth(w: number, marketAbsent: boolean): number {
  const raw = C.CONF_TOP * Math.exp(-(w - C.MIN_LOG_WIDTH) / C.CONF_SCALE);
  const score = Math.round(clamp(raw, C.CONF_MIN, C.CONF_MAX));
  return marketAbsent ? Math.min(score, C.CONF_CAP_NO_MARKET) : score;
}

export function strengthOf(nEff: number, marketPresent: boolean): Strength {
  if (!marketPresent) return "none";
  if (nEff < C.STRENGTH_THIN_BELOW) return "thin";
  if (nEff < C.STRENGTH_RICH_FROM) return "ok";
  return "rich";
}

/**
 * Where the comparables came from, as the calibration sees it. Same words as `MarketBasis.basis`
 * (market-tiers.ts) but "none" is folded into "local": with no market there is nothing foreign.
 */
export type EvidenceBasis = FallbackLevel;

/**
 * category|strength|basis[|mode]. The parent chain is: category|strength (all bases pooled), strength,
 * global. The basis lets the nightly calibration check, on real sales, whether data from another
 * country really is as noisy as FOREIGN_STD says (it never edits FOREIGN_STD by itself).
 */
export function bucketOf(category: string, strength: Strength, basis: EvidenceBasis = "local", mode?: "retail" | "auction"): string {
  const cat = category.trim().toLowerCase().replace(/[|\s]+/g, "_") || "unknown";
  const base = `${cat}|${strength}|${strength === "none" ? "local" : basis}`;
  // Optional 4th part. Parent chain (calibration.ts parentOf): cat|s|basis|mode -> cat|s|basis -> cat|s -> s -> global, so no cold start.
  return mode ? `${base}|${mode}` : base;
}

/** Local unless at least LOCAL_SHARE_FOREIGN_BELOW of the weight is foreign; then the heavier foreign tier. */
export function basisOf(foreignShare: number, regionalW: number, globalW: number): EvidenceBasis {
  if (!(foreignShare >= LOCAL_SHARE_FOREIGN_BELOW)) return "local";
  return globalW >= regionalW ? "global" : "regional";
}

// ---------------------------------------------------------------- 4A: comparables

/** A shift read from stored data: finite, and never beyond the clamp. Anything else is no shift. */
export function safeShift(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, -C.OFFSET_CLAMP, C.OFFSET_CLAMP) : 0;
}

/**
 * The noise (ln price) of a foreign tier: the guessed FOREIGN_STD, or the learned value of the country
 * pair when there is one. The learned value can only WIDEN (a narrower one would make foreign data count
 * for more than we have evidence for) and is capped at FOREIGN_STD_MAX_FACTOR times the guess.
 */
export function foreignStdOf(tier: FallbackLevel, learned?: number | null): number {
  const base = C.FOREIGN_STD[tier];
  if (tier === "local" || typeof learned !== "number" || !Number.isFinite(learned)) return base;
  return clamp(learned, base, base * C.FOREIGN_STD_MAX_FACTOR);
}
