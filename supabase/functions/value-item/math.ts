// "Matte och kontroll: kod" (diagram). The Judge only LABELS; every number is made here, by plain code.
//
//   in:  the Judge's labels per ad, the listings (already in USD by fx.ts), the risk label
//   1. throw away ads that are not the same item
//   2. remove statistical outliers (median / MAD)
//   3. relative_value band (9 bands; old 3-level label as fallback) -> FIXED factor from ad-calibration.ts, never a number from a model
//   4. median and interval (10th-90th percentile), in USD (present.ts / fx convert to the user's currency)
//   5. confidence from count, spread and risk
//   6. high risk: flag and a wider range
//   out: the verdict with price + confidence filled in, the adjusted price per kept ad, and the notes for the log.
//
// Pure and deterministic: no network, no randomness, no AI.

import { ASKING_TO_SOLD, CONDITION_FACTOR, CONF, RISK_WIDEN, MAD_TO_SIGMA, OUTLIER_CUT, OUTLIER_MAD_FLOOR, OUTLIER_MIN_COMPS, OUTLIER_MIN_KEEP } from "./interval.config.ts";
import { median, quantile } from "./stats.ts";
import { adFactor } from "./ad-calibration.ts";
import type { Finding, JudgeVerdict } from "./types.ts";

export { CONDITION_FACTOR, RISK_WIDEN, CONF }; // re-exported: the numbers now live in interval.config.ts

export interface MathNotes {
  considered: number;
  keptSame: number;
  droppedNotSame: number;
  droppedOutliers: number;
  usedSimilarFallback: boolean;
  spreadLn: number;
  widen: number;
}

export interface MathResult {
  /** Verdict with `price` and `confidence` set by code, and `same` reduced to the ads that survived steps 1-2. */
  verdict: JudgeVerdict;
  /** Adjusted price (USD) per surviving ad id: asking prices are NOT shifted here (the interval engine does that), only condition. */
  adjusted: Map<number, number>;
  notes: MathNotes;
}


/**
 * Returns null when there is no ad at all that is the same or similar: then no price can be made without a model
 * guessing it, and the caller asks for a better photo instead of inventing a number.
 */
export function priceFromLabels(verdict: JudgeVerdict, findings: Finding[], askingToSold: number = ASKING_TO_SOLD): MathResult | null {
  const labels = new Map((verdict.ads ?? []).map((a) => [a.id, a]));
  const usable = findings.filter((f) => f.priceUsd > 0 && labels.has(f.id));

  // 1. Throw away what is not the same item.
  let pool = usable.filter((f) => labels.get(f.id)!.match === "same");
  let usedSimilarFallback = false;
  if (pool.length === 0) {
    pool = usable.filter((f) => labels.get(f.id)!.match === "similar");
    usedSimilarFallback = pool.length > 0;
  }
  if (pool.length === 0) return null;
  const droppedNotSame = usable.length - pool.length;

  // 3 (before 2, so that outliers are judged on comparable money). Condition label -> fixed percentage. Asking prices are
  // brought to the level of sold prices (same 0.9 as the engine uses) so the median is not pulled up by wishful asks.
  const price = new Map<number, number>();
  for (const f of pool) {
    const factor = adFactor(labels.get(f.id)!, CONDITION_FACTOR);
    price.set(f.id, f.priceUsd * factor);
  }
  const level = (f: Finding) => (price.get(f.id) as number) * (f.kind === "sold" ? 1 : askingToSold);

  // 2. Statistical outliers: robust z-score on ln price, only when there are enough ads and never below the minimum kept.
  let kept = pool;
  if (pool.length >= OUTLIER_MIN_COMPS) {
    const ln = pool.map((f) => Math.log(level(f)));
    const med = median(ln);
    const mad = Math.max(OUTLIER_MAD_FLOOR, median(ln.map((x) => Math.abs(x - med)))); // same rule as interval.ts
    const cut = OUTLIER_CUT * MAD_TO_SIGMA * mad;
    const inliers = pool.filter((_, i) => Math.abs(ln[i] - med) <= cut);
    if (inliers.length >= OUTLIER_MIN_KEEP) kept = inliers;
  }
  const droppedOutliers = pool.length - kept.length;

  // 4. Median and interval.
  const levels = kept.map(level).sort((a, b) => a - b);
  const mid = median(levels);
  let low = quantile(levels, 0.1);
  let high = quantile(levels, 0.9);
  const spreadLn = levels.length > 1 ? Math.log(Math.max(high, 0.01) / Math.max(low, 0.01)) : 0.5;

  // 6. High risk: flag (done by check.ts from authenticity_risk) and a wider range.
  const widen = RISK_WIDEN[verdict.authenticity_risk] ?? 1;
  low = mid - (mid - low) * widen;
  high = mid + (high - mid) * widen;
  // A single ad (or identical prices) has no spread of its own: give the range a floor so it is never a point.
  const floor = 0.12 * widen;
  low = Math.max(0.01, Math.min(low, mid * (1 - floor)));
  high = Math.max(high, mid * (1 + floor));

  // 5. Confidence: number of ads, how much they disagree, sold prices, risk. Similar-only is capped.
  const sold = kept.filter((f) => f.kind === "sold").length;
  let conf =
    CONF.base +
    Math.min(CONF.maxCompBonus, kept.length * CONF.perComp) +
    Math.min(3, sold) * (CONF.soldBonus / 3) -
    Math.min(40, spreadLn * CONF.spreadPenalty) -
    (CONF.riskPenalty[verdict.authenticity_risk as keyof typeof CONF.riskPenalty] ?? CONF.riskPenalty.unknown);
  if (usedSimilarFallback) conf = Math.min(conf, 45);
  conf = Math.round(Math.max(5, Math.min(95, conf)));

  return {
    verdict: {
      ...verdict,
      same: usedSimilarFallback ? [] : kept.map((f) => f.id),
      similar: usedSimilarFallback ? kept.map((f) => f.id) : [],
      price: { low, mid, high },
      confidence: conf,
      missing: (verdict.missing ?? []).filter((m) => m !== "confidence" && m !== "price"),
    },
    adjusted: new Map(kept.map((f) => [f.id, price.get(f.id) as number])),
    notes: { considered: usable.length, keptSame: kept.length, droppedNotSame, droppedOutliers, usedSimilarFallback, spreadLn: Math.round(spreadLn * 1000) / 1000, widen },
  };
}
