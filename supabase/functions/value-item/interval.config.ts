// Every number the interval engine uses lives here and nowhere else.
// These are starting values. Calibration (l_calibration, nightly) corrects the overall width
// through `k`, so do not tune them by hand.

/** The interval is the central 80 percent range: the 10th to the 90th percentile. */
export const INTERVAL_LEVEL = 0.8 as const;

/** Normal 90th percentile. */
export const Z80 = 1.2816;

/** Student t, 90th percentile. Interpolated linearly in 1/df. */
export const T90_TABLE: ReadonlyArray<readonly [number, number]> = [
  [1, 3.078], [2, 1.886], [3, 1.638], [4, 1.533], [5, 1.476], [6, 1.44], [8, 1.397],
  [10, 1.372], [12, 1.356], [15, 1.341], [20, 1.325], [30, 1.31], [60, 1.296], [120, 1.289],
];

// ---------------------------------------------------------------- comparable weights
/** Same value as ASKING_TO_SOLD in check.ts (kept in sync by a test). Sold prices are never adjusted. */
export const ASKING_TO_SOLD = 0.9;

// ---------------------------------------------------------------- outliers (4A step 3)
export const OUTLIER_MIN_COMPS = 5;
export const OUTLIER_MIN_KEEP = 3;
export const OUTLIER_MAD_FLOOR = 0.05;
export const OUTLIER_CUT = 3.5;
export const MAD_TO_SIGMA = 1.4826;

// ---------------------------------------------------------------- category prior

// ---------------------------------------------------------------- the model (the Judge's own range)
export const SM_FLOOR = 0.12;

// ---------------------------------------------------------------- extra uncertainty
export const FOREIGN_STD = { local: 0, regional: 0.1, global: 0.18 } as const;
export type FallbackLevel = keyof typeof FOREIGN_STD;
/**
 * Ordinary listing-to-listing noise (ln price) inside one market. A foreign listing with extra noise
 * s_t is worth  s0^2 / (s0^2 + s_t^2)  of a local one (inverse variance). See market-tiers.ts.
 */
export const FOREIGN_NOISE_S0 = 0.2;
export const IDENTITY_SIMILAR_STD = 0.12;

// ---------------------------------------------------------------- learned price level and foreign noise
// A foreign listing is not only noisier, it can also sit at another price LEVEL (a US eBay price for a
// Swedish user). Both are learned per country pair (origin -> user) from real sales (l_feedback) by the
// table l_price_offsets (no job writes it any more; it stays empty). No data means no shift and the guessed
// FOREIGN_STD above: nothing is ever applied on a hunch.
/** A pair needs this many real sales (one per valuation) before its offset or its noise is used. */
export const OFFSET_MIN_REPORTS = 30;
/** The same, for the noise estimate (it needs fewer: it only ever WIDENS the guessed FOREIGN_STD). */
export const FOREIGN_STD_MIN_REPORTS = 20;
/** Shrinkage of an offset toward 0: n / (n + OFFSET_SHRINK_N), the same style as shrink() in calibration.ts. */
export const OFFSET_SHRINK_N = 15;
/** Largest shift in ln price (about plus or minus 28 percent). */
export const OFFSET_CLAMP = 0.25;
/** The learned noise may never exceed this multiple of the guessed value (and never go below it: only widening). */
export const FOREIGN_STD_MAX_FACTOR = 2;
/**
 * The Brain has no explicit "identity is similar" flag. Identification's own confidence (0-100)
 * stands in for it: below this the exact model counts as uncertain.
 */
export const IDENTITY_CONF_BELOW = 60;
export const COND_STD: Record<string, number> = { new: 0.06, "like-new": 0.06, good: 0.06, fair: 0.1, poor: 0.1 };
export const COND_STD_OTHER = 0.1;
export const RARITY_STD: Record<string, number> = { common: 0, unknown: 0.05, rare: 0.1, very_rare: 0.2 };
export const RARITY_STD_OTHER = 0.05;
export const UNKNOWN_STD_CAP = 0.12;
export const UNKNOWN_STD_PER = 0.03;
/** Lower side only. "unknown" is not in the spec: it sits between low and medium. */
export const AUTH_LOW_STD: Record<string, number> = { low: 0, unknown: 0.05, medium: 0.1, high: 0.2 };

// ---------------------------------------------------------------- degrees of freedom

// ---------------------------------------------------------------- floor, cap, confidence
/** Never narrower than about plus or minus 10 percent. */
export const MIN_LOG_WIDTH = 0.2;
/** Wider than this sets needsMoreInfo. */
export const CAP_LOG_WIDTH = Math.log(12);
export const HARD_FLOOR_SHARE = 0.1;
export const CONF_TOP = 95;
export const CONF_SCALE = 0.9;
export const CONF_MIN = 5;
export const CONF_MAX = 95;
/** with no market data the answer is a bounded estimate (marks, material, era). Calibrate later from l_feedback. */
export const CONF_CAP_NO_MARKET = 40;

// ---------------------------------------------------------------- width drivers
export const DRIVER_MIN_SHARE = 0.25;
export const DRIVER_MAX = 2;
export const FEW_COMPS_NEFF = 4;

// ---------------------------------------------------------------- calibration buckets
export const STRENGTH_THIN_BELOW = 4;
export const STRENGTH_RICH_FROM = 10;
export const K_MIN = 0.6;
export const K_MAX = 2.5;
export const K_DEFAULT = 1;

// ---------------------------------------------------------------- what is stored for calibration
/** Listings saved in l_runs.steps.interval.comps, so a backtest can replay the engine later. */
export const INTERVAL_COMPS_STORED = 15;

// ---------------------------------------------------------------- estimate mode (no market data, rung 5)
// Conservative starting tables. They are learned later from l_feedback (nightly job, shrunk toward these).
/** price = anchor x depreciation(category, age_class, condition) x rarity multiplier. */
export const AGE_CLASSES = ["new", "recent", "mid", "old", "vintage", "antique", "unknown"] as const;
export type AgeClass = (typeof AGE_CLASSES)[number];
/** Depreciation of the typical-new price by age class (used goods). Only for anchors whose basis is a NEW price: a "comparable_objects" anchor is already a market value and is never depreciated (anchor.ts). */
export const DEPRECIATION_BY_AGE: Readonly<Record<AgeClass, number>> = { new: 0.85, recent: 0.6, mid: 0.4, old: 0.28, vintage: 0.3, antique: 0.3, unknown: 0.4 };
/** Per category override of the age table (multiplier applied on top). Empty until learned. */
export const DEPRECIATION_CATEGORY_MULT: Readonly<Record<string, number>> = { electronics: 0.85, jewelry: 1.1, watches: 1.05, furniture: 0.9 };
export const CONDITION_MULT: Readonly<Record<string, number>> = { new: 1.1, "like-new": 1.0, good: 0.88, fair: 0.7, poor: 0.5, unknown: 0.85 };
export const RARITY_MULT: Readonly<Record<string, number>> = { common: 1, unknown: 1, rare: 1.3, very_rare: 1.7 };
/** Basis of the anchor decides how far it can be trusted: ln-spread of the anchor itself. */
export const ANCHOR_BASIS_STD: Readonly<Record<string, number>> = { known_model: 0.35, brand_category_typical: 0.6, comparable_objects: 0.9, none: 0.9 };
/** Sanity lower limit for any anchor in USD: reject non-finite, non-positive and below this. Upper bound: MAX_PRICE (validate.ts). */
export const ANCHOR_MIN_USD = 1;
// No per-category or per-basis price caps (owner requirement). The only upper bound is MAX_PRICE in validate.ts.

// ---------------------------------------------------------------- comparables preparation
/** Condition label (ours vs the ad) -> fixed factor. Replaced by the learned condition table when the Judge-driven engine lands. */
export const CONDITION_FACTOR = { worse: 0.85, equal: 1, better: 1.1 } as const;
/** Widening of the range for authenticity risk (math.ts). TO BE DELETED when risk enters the engine once (spec 4.2 item 6). */
export const RISK_WIDEN: Readonly<Record<string, number>> = { high: 1.6, medium: 1.2, low: 1, unknown: 1.1 };
/** math.ts confidence recipe. TO BE DELETED: confidence has one source, scoreFromWidth (spec 4.2 item 8). */
export const CONF = { base: 30, perComp: 9, maxCompBonus: 45, soldBonus: 6, spreadPenalty: 60, riskPenalty: { high: 30, medium: 12, low: 0, unknown: 6 } } as const;

// ---------------------------------------------------------------- Judge disagreements (consistency.ts)
/** Each rule that fired in the consistency adjudicator widens the interval (ln std, added in quadrature) and lowers confidence through the width. */
export const JUDGE_DISAGREE_STD_PER = 0.05;
export const JUDGE_DISAGREE_STD_CAP = 0.15;
