// Ad noise calibration table. ONE place that turns the Judge's BANDS into numbers.
// The Judge never writes a number: it picks a band, code maps the band here. Defaults reproduce the earlier placeholders exactly
// (same 0.03, similar 0.12, asking +0.02), so nothing moves until the nightly fit (the calibrate function, l_judge_log) rewrites a row.
// Pure, deterministic, bounded. Every output is finite.

export type PSameBand = "certain" | "likely" | "unsure" | "unlikely" | "no";
export type Reliability = "high" | "normal" | "low";

/** ln-variance an ad carries because it may not be exactly the item. */
export const P_SAME_SE2: Record<PSameBand, number> = { certain: 0.03, likely: 0.06, unsure: 0.12, unlikely: 0.25, no: Infinity };
/** Extra ln-variance by how far the ad itself can be trusted (price typo, bundle, parts-only wording). */
export const RELIABILITY_SE2: Record<Reliability, number> = { high: 0, normal: 0, low: 0.08 };
export const ASKING_EXTRA_SE2 = 0.02;
export const AD_SE2_MAX = 0.6;
/** Coarse label (old Judge output) -> band, so old and new Judge output share one table. */
export const BAND_OF_MATCH = { same: "certain", similar: "unsure" } as const;

// ---- relative_value (replaces the 3-level condition_vs_ad). The Judge says how much the item in the PHOTO is worth
// compared with the item in the AD, because of condition, completeness, accessories, box and papers (NEVER because of a
// different variant: that goes to p_same / variant_diffs). Nine ordered bands; code owns every number. Factors are about
// symmetric in ln space (+-0.08, 0.17, 0.28, 0.45). UNPROVEN: the nightly fit from l_judge_log rewrites them.
export const RELATIVE_BANDS = ["much_worse", "clearly_worse", "worse", "slightly_worse", "equal", "slightly_better", "better", "clearly_better", "much_better"] as const;
export type RelativeBand = (typeof RELATIVE_BANDS)[number];
/** Multiplier applied to the ad's price to bring it to the item in the photo. */
export const RELATIVE_FACTOR: Record<RelativeBand, number> = {
  much_worse: 0.64, clearly_worse: 0.75, worse: 0.84, slightly_worse: 0.92, equal: 1,
  slightly_better: 1.08, better: 1.18, clearly_better: 1.33, much_better: 1.57,
};
/** Extra ln-variance: the bigger the claimed difference, the less sure it is. equal = 0. */
export const RELATIVE_SE2: Record<RelativeBand, number> = {
  much_worse: 0.03, clearly_worse: 0.02, worse: 0.01, slightly_worse: 0.003, equal: 0,
  slightly_better: 0.003, better: 0.01, clearly_better: 0.02, much_better: 0.03,
};
/** Old 3-level label -> band, so old Judge answers (and old stored recipes) keep their old factors: worse 0.85, better 1.1. */
export const RELATIVE_OF_OLD = { worse: "worse", equal: "equal", better: "slightly_better" } as const;
/** Old 3-level label the engine still uses for display and legacy code: derived from the band. */
export function oldConditionOf(b: RelativeBand): "worse" | "equal" | "better" {
  const f = RELATIVE_FACTOR[b];
  return f < 0.97 ? "worse" : f > 1.03 ? "better" : "equal";
}
/** Factor for one ad label. A valid band wins; otherwise the old 3-level label (0.85 / 1 / 1.1); otherwise 1. */
export function adFactor(l: { relative_value?: string | null; condition_vs_ad?: string | null }, oldFactor: Record<string, number>): number {
  if (l.relative_value && l.relative_value in RELATIVE_FACTOR) return RELATIVE_FACTOR[l.relative_value as RelativeBand];
  return (l.condition_vs_ad && oldFactor[l.condition_vs_ad]) || 1;
}

export interface AdNoiseInput {
  match?: "same" | "similar" | string;
  pSame?: PSameBand | null;
  reliability?: Reliability | null;
  /** relative_value band: a big claimed difference adds a little variance. */
  relative?: RelativeBand | null;
  asking: boolean;
}

/** ln-variance of one ad, or null when the ad must not be used at all (band `no`). */
export function adNoise(a: AdNoiseInput): number | null {
  const band: PSameBand | null =
    a.pSame && a.pSame in P_SAME_SE2 ? a.pSame : a.match === "same" ? BAND_OF_MATCH.same : a.match === "similar" ? BAND_OF_MATCH.similar : a.match == null ? BAND_OF_MATCH.same : null;
  if (!band) return null;
  const base = P_SAME_SE2[band];
  if (!Number.isFinite(base)) return null;
  const rel = a.reliability && a.reliability in RELIABILITY_SE2 ? RELIABILITY_SE2[a.reliability] : 0;
  const rv = a.relative && a.relative in RELATIVE_SE2 ? RELATIVE_SE2[a.relative] : 0;
  return Math.min(AD_SE2_MAX, base + rel + rv + (a.asking ? ASKING_EXTRA_SE2 : 0));
}

/**
 * Shared-bias floor input, 0..1: how unsure the exact variant is. Unlike per-ad noise it does NOT shrink with more ads.
 * Inputs are all optional: identification confidence 0..100, whether identity is only similar, share of ads labelled similar,
 * and an optional certainty. The result is the larger of the signals plus a small mix, clamped.
 */
export function variantAmbiguityOf(o: { identConfidence?: number | null; identitySimilar?: boolean; similarShare?: number | null; diffShare?: number | null; certainty?: "high" | "medium" | "low" | null }): number {
  const f = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const conf = f(o.identConfidence);
  const fromIdent = conf == null ? 0.1 : conf >= 80 ? 0.1 : conf >= 60 ? 0.25 : 0.5;
  const fromSim = o.identitySimilar ? 0.5 : 0;
  const share = f(o.similarShare);
  const fromShare = share == null ? 0 : Math.min(0.5, Math.max(0, share) * 0.5);
  const dshare = f(o.diffShare);
  const fromDiff = dshare == null ? 0 : Math.min(0.4, Math.max(0, dshare) * 0.4);
  const fromCert = o.certainty === "low" ? 0.4 : o.certainty === "medium" ? 0.2 : 0;
  const top = Math.max(fromIdent, fromSim, fromShare, fromDiff, fromCert);
  const rest = fromIdent + fromSim + fromShare + fromDiff + fromCert - top;
  return Math.min(0.8, top + 0.1 * Math.min(1, rest));
}
