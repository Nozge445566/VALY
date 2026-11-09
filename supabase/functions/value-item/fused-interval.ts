// The fused interval engine. A pure function of the SAME recipe the old engine reads (plus optional
// independent anchors), so a backtest replays it exactly. It is the ONLY interval engine (the old buildInterval was deleted;
// recipe shape v1 can no longer be replayed). Everything numeric comes from fusion.ts and interval.config.ts. No network, no model text.

import * as C from "./interval.config.ts";
import { fuse } from "./fusion.ts";
import { adNoise, variantAmbiguityOf } from "./ad-calibration.ts";
import type { FusionAd, FusionSource } from "./fusion.ts";
import { basisOf, bucketOf, foreignStdOf, safeShift, scoreFromWidth, strengthOf, t90 } from "./interval.ts";
import type { IntervalInput, IntervalOutput, WidthDriver } from "./interval.ts";

/** One independent source (Judge-A, Identification anchor, later the neighbour prior), as stored in the recipe. */
export interface RecipeSource {
  name: string;
  /** ln USD */
  mu: number;
  sd: number;
}

export interface FusedIntervalInput extends IntervalInput {
  sources?: RecipeSource[];
  /** 0..1, how unsure the exact variant is. */
  variantAmbiguity?: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);

/** Recipe comps -> fusion ads. Asking prices to sold level, learned shift for foreign ads, foreign noise added to the variance. */
export function fusionAdsOf(comps: IntervalInput["comps"], defaultTier: IntervalInput["fallbackLevel"] = "local"): FusionAd[] {
  return fusionAdsDetailed(comps, defaultTier).map((x) => x.ad);
}

/** Same as fusionAdsOf, with each ad's tier, noise and shift kept beside it (for the evidence basis and the breakdown). */
export function fusionAdsDetailed(comps: IntervalInput["comps"], defaultTier: IntervalInput["fallbackLevel"] = "local", askingToSold: number = C.ASKING_TO_SOLD): { ad: FusionAd; tier: "local" | "regional" | "global"; std: number; shift: number }[] {
  const out: { ad: FusionAd; tier: "local" | "regional" | "global"; std: number; shift: number }[] = [];
  for (const c of comps) {
    if (!(Number.isFinite(c.priceUsd) && c.priceUsd > 0)) continue;
    const asking = c.kind !== "sold";
    const tier = c.tier ?? defaultTier ?? "local";
    const shift = tier !== "local" ? safeShift(c.shiftLn) : 0;
    const price = (asking ? c.priceUsd * askingToSold : c.priceUsd) * Math.exp(shift);
    const s = foreignStdOf(tier, c.extraStd);
    const foreign = tier !== "local" ? s * s : 0;
    const noise = adNoise({ match: c.match, pSame: c.pSame, reliability: c.reliability, relative: c.relative, asking });
    if (noise == null) continue;
    out.push({ ad: { y: Math.log(price), se2: noise + foreign }, tier, std: tier !== "local" ? s : 0, shift });
  }
  return out;
}

export function buildFusedInterval(input: FusedIntervalInput): IntervalOutput {
  const detailed = fusionAdsDetailed(input.comps, input.fallbackLevel, Number.isFinite(input.askingToSold) && (input.askingToSold as number) > 0 ? (input.askingToSold as number) : C.ASKING_TO_SOLD);
  const ads = detailed.map((x) => x.ad);
  const sources: FusionSource[] = (input.sources ?? []).map((s) => ({ name: s.name, mu: s.mu, sd: s.sd }));
  // No ads and no independent source: the verdict's own range (e.g. the estimate-mode anchor) is the only evidence.
  const marketAbsent = ads.length === 0;
  if (marketAbsent && sources.length === 0) {
    const m = input.model;
    const mid = Math.max(0.01, fin(m.mid, 0.01));
    const sd = Math.max(C.SM_FLOOR, (Math.log(Math.max(m.high, mid)) - Math.log(Math.max(Math.min(m.low, mid), 0.001))) / (2 * C.Z80));
    sources.push({ name: "model", mu: Math.log(mid), sd });
  }
  const f = fuse({ ads, sources, variantAmbiguity: input.variantAmbiguity ?? variantAmbiguityOf({ identitySimilar: input.identitySimilar, similarShare: input.comps.length ? input.comps.filter((c) => c.match === "similar").length / input.comps.length : null }) })!;

  // Extras that are NOT in the ads or sources. Risk enters ONCE: on the low side only.
  const condStd = C.COND_STD[input.condition] ?? C.COND_STD_OTHER;
  const rarityStd = C.RARITY_STD[input.rarity ?? "unknown"] ?? C.RARITY_STD_OTHER;
  const unknownStd = Math.min(C.UNKNOWN_STD_CAP, C.UNKNOWN_STD_PER * Math.max(0, input.unknownsCount - 1));
  const authStd = C.AUTH_LOW_STD[input.authenticityRisk] ?? C.AUTH_LOW_STD.unknown;
  const disagreeStd = Math.min(C.JUDGE_DISAGREE_STD_CAP, C.JUDGE_DISAGREE_STD_PER * Math.max(0, input.judgeDisagreements ?? 0));
  const extras2 = condStd ** 2 + rarityStd ** 2 + unknownStd ** 2 + disagreeStd ** 2;
  const sTot2 = f.sd * f.sd + extras2;
  const sLow2 = sTot2 + authStd ** 2;

  const nEff = f.nEff;
  // Evidence basis from the INFLUENCE each foreign ad really had (not from how many there are), so calibration buckets stay honest.
  const inf = f.influence.length === detailed.length ? f.influence : detailed.map(() => 1 / Math.max(1, detailed.length));
  const wOf = (pred: (t: string) => boolean) => detailed.reduce((a, x, i) => a + (pred(x.tier) ? inf[i] : 0), 0);
  const foreignShare = wOf((t) => t !== "local");
  const basis = ads.length ? basisOf(foreignShare, wOf((t) => t === "regional"), wOf((t) => t === "global")) : "local";
  const foreignVar = detailed.reduce((a, x, i) => a + inf[i] * x.std * x.std, 0);
  const shiftLn = detailed.reduce((a, x, i) => a + inf[i] * x.shift, 0);
  const bucket = bucketOf(input.category, strengthOf(nEff, !marketAbsent), basis, input.mode);
  const kWanted = input.kOf ? input.kOf(bucket) : input.k;
  const k = clamp(fin(kWanted ?? C.K_DEFAULT, C.K_DEFAULT), C.K_MIN, C.K_MAX);
  const t = t90(f.df);

  let lnLow = f.mu - k * t * Math.sqrt(sLow2);
  let lnHigh = f.mu + k * t * Math.sqrt(sTot2);
  let w = lnHigh - lnLow;
  if (w < C.MIN_LOG_WIDTH) {
    const delta = (C.MIN_LOG_WIDTH - w) / 2;
    lnLow -= delta;
    lnHigh += delta;
  }
  const mid = Math.exp(f.mu);
  const high = Math.exp(lnHigh);
  const low = Math.max(Math.exp(lnLow), C.HARD_FLOOR_SHARE * mid);
  w = Math.log(high / low);

  const shares: [WidthDriver, number][] = [];
  if (marketAbsent) shares.push(["model_only", 1]);
  if (!marketAbsent && nEff < C.FEW_COMPS_NEFF) shares.push(["few_comparables", (f.sd * f.sd) / sTot2]);
  shares.push(["sources_disagree", (f.tempered.length > 0 ? 0.3 : 0) + f.tau2 / sTot2]);
  shares.push(["mostly_asking_prices", ads.length > 0 ? input.comps.filter((c) => c.kind !== "sold").length / input.comps.length * 0.1 : 0]);
  shares.push(["rarity", rarityStd ** 2 / sTot2]);
  shares.push(["unclear_condition", condStd ** 2 / sTot2]);
  shares.push(["authenticity", authStd ** 2 / sLow2]);
  shares.push(["identity", input.identitySimilar ? C.IDENTITY_SIMILAR_STD ** 2 / sTot2 : 0]);
  shares.push(["judge_disagreement", disagreeStd ** 2 / sTot2]);
  const widthDrivers = shares.filter(([, s]) => s >= C.DRIVER_MIN_SHARE).sort((a, b) => b[1] - a[1]).slice(0, C.DRIVER_MAX).map(([c]) => c);

  return {
    low, mid, high,
    confidenceScore: scoreFromWidth(w, marketAbsent),
    intervalLevel: C.INTERVAL_LEVEL,
    widthDrivers,
    needsMoreInfo: w > C.CAP_LOG_WIDTH,
    marketWeight: f.adsWeight,
    breakdown: {
      mu: f.mu, muM: f.mu, muK: ads.length ? f.mu : null, sK2: null, seK2: null, sM: f.sd, tauC2: f.tau2, d: null,
      foreignShare, foreignStd: Math.sqrt(foreignVar), shiftLn, basis,
      extras2, sLow2, sHigh2: sTot2, df: f.df, t, k, bucket, n_eff: nEff, fallbackLevel: input.fallbackLevel ?? "local", w,
    },
  };
}
