// Fusion engine Pure, deterministic, no network, input never mutated.
// Works in ln(USD). Steps: per-ad precision -> Huber location -> DerSimonian-Laird tau^2 (between-ad spread) -> random-effects
// mean with an influence cap per ad -> shared-bias guard (all ads share one variant ambiguity, which more ads cannot average away)
// -> precision-weighted Bayesian fusion with independent sources (anchor, neighbour prior), each tempered when it disagrees
// with the ads -> Satterthwaite-style df -> t-based interval. Used by fused-interval.ts, the only interval engine.

import { huber } from "./stats.ts";
import { t90 } from "./interval.ts";

export interface FusionAd {
  /** ln of the ad price in USD (already converted). */
  y: number;
  /** Within-ad variance in ln space (>0): how noisy this single ad is as evidence for THIS item. */
  se2: number;
}
export interface FusionSource {
  name: string;
  /** ln of the source's estimate in USD. */
  mu: number;
  /** Its ln standard deviation (>0). */
  sd: number;
}
export interface FusionInput {
  ads: FusionAd[];
  sources?: FusionSource[];
  /** 0..1: how ambiguous the exact variant is. Adds a bias variance that does NOT shrink with more ads. */
  variantAmbiguity?: number;
  /** Max share of total weight any single ad may hold (default 0.35, only applied when >= 3 ads). */
  influenceCap?: number;
  /** Extra ln variance for the new item itself (price spread between two items of the same model). Default 0.01. */
  itemVar?: number;
}
export interface FusionOutput {
  mu: number;
  sd: number;
  df: number;
  low: number;
  mid: number;
  high: number;
  tau2: number;
  nEff: number;
  /** Per-ad influence, sums to 1 over the ads (empty when there are no ads). */
  influence: number[];
  /** Per-source posterior weight, sums with adsWeight to 1. */
  sourceWeights: Record<string, number>;
  adsWeight: number;
  /** Sources whose estimate disagreed with the ads by > 2 sd and were tempered. */
  tempered: string[];
  biasVar: number;
}

const fin = (x: number, d: number) => (Number.isFinite(x) ? x : d);
const MIN_VAR = 1e-4;

/** Caps each weight at cap*total by redistributing the excess over the uncapped ones (fixed iterations). */
export function capInfluence(w: number[], cap: number): number[] {
  const n = w.length;
  if (n < 3) return [...w];
  const c = Math.min(1, Math.max(1 / n + 1e-9, cap));
  let out = [...w];
  for (let it = 0; it < 10; it++) {
    const total = out.reduce((a, b) => a + b, 0);
    if (total <= 0) return out;
    const lim = c * total;
    const over = out.filter((x) => x > lim + 1e-12);
    if (over.length === 0) break;
    const free = out.filter((x) => x <= lim + 1e-12).reduce((a, b) => a + b, 0);
    const excess = over.reduce((a, b) => a + (b - lim), 0);
    out = out.map((x) => (x > lim ? lim : free > 0 ? x + (excess * x) / free : x));
  }
  return out;
}

export function fuse(input: FusionInput): FusionOutput | null {
  const ads = input.ads.filter((a) => Number.isFinite(a.y) && Number.isFinite(a.se2) && a.se2 > 0);
  const sources = (input.sources ?? []).filter((s) => Number.isFinite(s.mu) && Number.isFinite(s.sd) && s.sd > 0);
  if (ads.length === 0 && sources.length === 0) return null;
  const itemVar = Math.max(0, fin(input.itemVar ?? 0.01, 0.01));
  const amb = Math.min(1, Math.max(0, fin(input.variantAmbiguity ?? 0, 0)));
  const biasVar = amb * amb * 0.04; // up to 0.2 ln (about 22 percent) shared bias at full ambiguity

  let adsMu = 0, adsVar = Infinity, tau2 = 0, nEff = 0, influence: number[] = [];
  const k = ads.length;
  if (k > 0) {
    const y = ads.map((a) => a.y);
    const w0 = ads.map((a) => 1 / Math.max(MIN_VAR, a.se2));
    // Robust centre: Huber location with precision weights. Used to down-weight outlying ads before the variance step.
    const centre = huber(y, w0);
    const sc = Math.max(0.05, Math.sqrt(ads.reduce((s, a, i) => s + w0[i] * (a.y - centre) ** 2, 0) / w0.reduce((a, b) => a + b, 0)));
    const huberW = ads.map((a) => { const r = Math.abs(a.y - centre) / (1.345 * sc); return r <= 1 ? 1 : 1 / (r * r); }); // soft redescending: far outliers lose influence faster than plain Huber
    const wr = w0.map((w, i) => w * huberW[i]);
    // DerSimonian-Laird between-ad variance around the precision-weighted mean.
    const sw = wr.reduce((a, b) => a + b, 0);
    const mw = ads.reduce((s, a, i) => s + wr[i] * a.y, 0) / sw;
    const Q = ads.reduce((s, a, i) => s + wr[i] * (a.y - mw) ** 2, 0);
    const sw2 = wr.reduce((s, w) => s + w * w, 0);
    const denom = sw - sw2 / sw;
    tau2 = k > 1 && denom > 0 ? Math.max(0, (Q - (k - 1)) / denom) : 0;
    tau2 = Math.min(tau2, 1); // ln variance of 1 would already mean "no information"
    // Random-effects weights with the influence cap.
    const wStar = capInfluence(ads.map((a, i) => (1 / (a.se2 + tau2)) * huberW[i]), input.influenceCap ?? 0.35);
    const sS = wStar.reduce((a, b) => a + b, 0);
    influence = wStar.map((w) => w / sS);
    adsMu = ads.reduce((s, a, i) => s + influence[i] * a.y, 0);
    // Variance of the mean: sum of squared influence times each ad's total variance.
    adsVar = ads.reduce((s, a, i) => s + influence[i] ** 2 * (a.se2 + tau2), 0);
    nEff = 1 / influence.reduce((s, p) => s + p * p, 0);
    adsVar += biasVar; // shared bias: more ads cannot remove it
  }

  // Bayesian fusion with independent sources. A source far from the ads is tempered (variance grows), never trusted blindly.
  const parts: { name: string; mu: number; v: number }[] = [];
  const tempered: string[] = [];
  if (k > 0) parts.push({ name: "ads", mu: adsMu, v: Math.max(MIN_VAR, adsVar) });
  for (const s of sources) {
    let v = s.sd * s.sd;
    if (k > 0) {
      const z = Math.abs(s.mu - adsMu) / Math.sqrt(v + Math.max(MIN_VAR, adsVar));
      if (z > 2) { v *= 1 + (z - 2) ** 2; tempered.push(s.name); }
    }
    parts.push({ name: s.name, mu: s.mu, v: Math.max(MIN_VAR, v) });
  }
  const prec = parts.map((p) => 1 / p.v);
  const sp = prec.reduce((a, b) => a + b, 0);
  const mu = parts.reduce((s, p, i) => s + (prec[i] / sp) * p.mu, 0);
  const postVar = 1 / sp;
  // Disagreement between independent parts is itself uncertainty (between-source variance).
  const between = parts.length > 1 ? parts.reduce((s, p, i) => s + (prec[i] / sp) * (p.mu - mu) ** 2, 0) : 0;
  const predVar = postVar + between + itemVar + (k > 0 ? tau2 : 0);
  const sd = Math.sqrt(predVar);
  // Satterthwaite-style df: ads contribute n_eff-1, each independent source counts as 2 df; floor 1.
  const df = Math.max(1, (k > 0 ? Math.max(0, nEff - 1) : 0) + 2 * sources.length);
  const t = t90(df);
  const sourceWeights: Record<string, number> = {};
  let adsWeight = 0;
  parts.forEach((p, i) => { if (p.name === "ads") adsWeight = prec[i] / sp; else sourceWeights[p.name] = prec[i] / sp; });
  return { mu, sd, df, low: Math.exp(mu - t * sd), mid: Math.exp(mu), high: Math.exp(mu + t * sd), tau2, nEff, influence, sourceWeights, adsWeight, tempered, biasVar };
}
