// "Se marknadsdata" / "Se hur vi värderade": the server's side of the decision.
//
// The Judge says how well each kept ad matches the item as a BAND (ad-calibration.ts); here a band becomes a share (0..1) that the
// app can compare with the threshold. The threshold and the minimum number of ads are configuration (MARKET_MIN_MATCH, MARKET_MIN_ADS,
// MARKET_MAX_ADS), so they change without a new app release. The app never decides the threshold: it receives `marketAds`.
//
// Honesty: an ad with no match score (old saved results, Memory hits) never qualifies. Nothing here invents a number.

import type { PSameBand } from "./ad-calibration.ts";
import { BAND_OF_MATCH } from "./ad-calibration.ts";
import type { ExplainFacts, Identification, JudgeVerdict, ResultComparable, AuthenticityReport } from "./types.ts";

/** How well an ad matches the item, per band. "unlikely" and "no" never reach the 80 % bar. */
export const MATCH_OF_BAND: Record<PSameBand, number> = { certain: 0.97, likely: 0.88, unsure: 0.6, unlikely: 0.3, no: 0 };

export interface MarketAdsPolicy {
  /** 0..1. An ad shows only at or above this. */
  minMatch: number;
  /** Fewer qualifying ads than this: no market link (the explanation link shows instead). */
  minAds: number;
  /** At most this many ads are sent. */
  maxAds: number;
}

export const DEFAULT_MARKET_ADS_POLICY: MarketAdsPolicy = { minMatch: 0.8, minAds: 2, maxAds: 3 };

/** The match share of one kept ad, or undefined when the Judge gave nothing to go on. */
export function matchOfAd(ad: { match?: string; p_same?: string } | undefined): number | undefined {
  if (!ad) return undefined;
  const band = (ad.p_same && ad.p_same in MATCH_OF_BAND ? (ad.p_same as PSameBand) : undefined) ??
    (ad.match === "same" ? BAND_OF_MATCH.same : ad.match === "similar" ? BAND_OF_MATCH.similar : undefined);
  return band ? MATCH_OF_BAND[band] : undefined;
}

/** The ads that pass the bar, best match first, at most `maxAds`. Fewer than `minAds`: none (the app then shows the explanation). */
export function marketAdsOf(comparables: readonly ResultComparable[], policy: MarketAdsPolicy): ResultComparable[] {
  const ok = comparables
    .filter((c) => typeof c.match === "number" && c.match >= policy.minMatch && /^https?:\/\//i.test(c.url) && c.price > 0)
    .sort((a, b) => (b.match ?? 0) - (a.match ?? 0))
    .slice(0, policy.maxAds);
  return ok.length >= policy.minAds ? ok : [];
}

/** USD. A valuation at or above this is "high value" for the expert tip in the explanation. */
export const HIGH_VALUE_USD = 500;

/** The facts the explanation may use. Only what the pipeline really knows; null stays null (the writer must not mention it). */
export function explainFactsOf(args: {
  ident: Identification | null;
  authenticity: AuthenticityReport | null | undefined;
  verdict: JudgeVerdict;
  midUsd: number;
  identConfidence: number | null | undefined;
}): ExplainFacts {
  const { ident, authenticity, verdict, midUsd } = args;
  const clean = (s: string | null | undefined) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 60) : null);
  const era = clean(ident?.era) ?? clean(authenticity?.era);
  const origin = clean(ident?.origin_country);
  const antique = ident?.age_class === "antique";
  return {
    era,
    origin,
    material: clean(ident?.material) ?? clean(authenticity?.material_hint),
    identConfidence: typeof args.identConfidence === "number" && Number.isFinite(args.identConfidence) ? Math.max(0, Math.min(100, args.identConfidence)) : null,
    antique,
    highValueOrAntique: antique || midUsd >= HIGH_VALUE_USD,
    grade: verdict.condition.grade,
  };
}

export function applyMarketAds<T extends { comparables: ResultComparable[] }>(result: T, policy: MarketAdsPolicy): T & { marketAds: ResultComparable[]; minAds: number } {
  return { ...result, marketAds: marketAdsOf(result.comparables, policy), minAds: policy.minAds };
}
