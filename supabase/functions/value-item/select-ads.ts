// Which ads reach the Judge. Pure, deterministic, no network, no randomness, a few hundred microseconds for 40 ads.
//
// The question: from N ads Market Live found, which K (JUDGE_MAX_ADS) tell us the most about what the item is worth?
// Not "the first K", not a hand-made score. It is a small statistical model, solved exactly:
//
//  1. MODEL. For ad i let z_i be its log price (asking prices shifted by a listing-optimism offset). The item's true
//     log value is mu. Each ad is either an INLIER, z_i ~ N(mu, s_i^2), or an OUTLIER (typo, lot, other product, wrong
//     currency), z_i ~ N(mu, TAU_OUT^2). The prior outlier rate of an ad is 1 - rel_i, where rel_i is how much its SOURCE
//     is trusted (a Beta belief per site; Search AI owns and learns it over time, see SourceBelief).
//  2. ROBUST INFERENCE. EM on that contaminated-normal mixture gives mu, a global dispersion scale c and, per ad, the
//     posterior probability r_i that it is an inlier. No threshold on the price, no median cut-off: an ad is
//     distrusted exactly as far as the data and its source say.
//  3. CORRELATED NOISE. Ads are not independent witnesses. Two ads from the same site share a bias, two from the same
//     search share a ranking effect, two with near-identical titles are often the same listing posted twice. The error
//     covariance is  Sigma = diag(v_i) + tau_site^2 * [same site] + tau_search^2 * [same search] + tau_title^2 * Jaccard(title_i, title_j).
//     Every term is positive semi-definite, so Sigma is always a valid covariance.
//     v_i = (c * sigma_i)^2 / (r_i * rel_i): the noise of one ad, inflated when it is probably an outlier or comes
//     from a source nobody trusts.
//  4. DESIGN. The Fisher information about mu from a set S of ads under that covariance is  I(S) = 1' Sigma_S^-1 1
//     (generalised least squares). We pick S of size K by greedy A-optimal design: the posterior variance of mu is
//     1 / I(S), so we repeatedly add the ad with the largest information gain
//          gain(j | S) = (1 - 1' a)^2 / d_j^2,   a = Sigma_S^-1 Sigma_{S,j},   d_j^2 = Sigma_jj - Sigma_{S,j}' a
//     (block inverse / Schur complement, exact, updated incrementally). Diversity is not a bolted-on bonus: it falls out
//     of the correlations, because a clone of an ad already chosen adds almost nothing.
//  5. WHAT SEARCH AI GETS. The trace returns, per source, how many ads it delivered and how many were inliers
//     (sum of r_i). That is exactly the evidence a Beta-Bernoulli learner needs: updateBelief() adds it to the
//     source's belief, the next selection trusts that source more or less, which picks better ads, which gives
//     cleaner evidence. Prior and learner are one loop: this is the hook where Search AI plugs in.
//
// Today every source starts from the same default prior, so the selection is already driven by the data alone.
import type { Finding } from "./types.ts";
import { tierRank } from "./market-tiers.ts";

/** How many ads reach the Judge. ONE source of truth. */
export const JUDGE_MAX_ADS = 7;
/** How many ads Market Live keeps in total (the first JUDGE_MAX_ADS are the Judge's). */
export const MAX_FINDINGS = 16;

type Ad = Omit<Finding, "id">;

// ---------------------------------------------------------------- Search AI's side: beliefs about sources

/** A Beta(alpha, beta) belief that an ad from this source is a clean inlier. */
export interface SourceBelief {
  alpha: number;
  beta: number;
}
export const reliabilityOf = (b: SourceBelief): number => b.alpha / (b.alpha + b.beta);
/** Conjugate update with fractional evidence (sum of r_i as successes). `forget` < 1 slowly discounts old evidence (markets drift). */
export function updateBelief(b: SourceBelief, inlierMass: number, n: number, forget = 1): SourceBelief {
  const m = Math.max(0, Math.min(n, inlierMass));
  return { alpha: b.alpha * forget + m, beta: b.beta * forget + (n - m) };
}
/** The prior of a source nobody has learned yet: sold prices are cleaner than asking prices. Worth 20 observations. */
export const DEFAULT_BELIEF = (kind: Ad["kind"]): SourceBelief => (kind === "sold" ? { alpha: 19, beta: 1 } : { alpha: 17.6, beta: 2.4 });

export interface SelectOptions {
  /** Ads to return (Market Live may find more). */
  max?: number;
  /** The first this-many are what the Judge gets. */
  judgeSlots?: number;
  /** Search AI's belief about an ad's source. Missing: DEFAULT_BELIEF. This is the collision point. */
  belief?: (f: Ad) => SourceBelief | undefined;
}

// ---------------------------------------------------------------- the model's constants (log-price space)

const SIGMA_KIND = { sold: 0.1, asking: 0.2 }; // sd of one ad's log price around the item's value
const TIER_INFLATION: Record<string, number> = { local: 1, regional: 1.25, global: 1.6 };
const ASKING_OFFSET = 0.08; // listing optimism: asking sits about 8% above what it sells for
const TAU_OUT = 1.2; // outliers are off by a factor of ~3 (sd in log space)
const TAU_SITE = 0.08; // shared bias of one site
const TAU_SEARCH = 0.05; // shared ranking effect of one search
const TAU_TITLE = 0.1; // shared "it is the same listing" effect
const EM_ITERATIONS = 12;
const SCALE_MIN = 0.6;
const SCALE_MAX = 3;
const UNPRICED_SD = 2; // an ad without a usable price says nothing about the value

// ---------------------------------------------------------------- small helpers

const wordsOf = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 1));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
const median = (xs: number[]): number => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const normPdf = (x: number, sd: number): number => Math.exp(-0.5 * (x / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));

// ---------------------------------------------------------------- the trace

export interface SelectionTrace {
  /** The item's estimated log value (after the asking offset). */
  muLog: number;
  /** Global dispersion scale found by EM (1 = the model's default noise fits). */
  scale: number;
  /** Fisher information of the ads the Judge gets, and the posterior sd of the log value they give (about the relative error). */
  infoJudgeSet: number;
  sdLogJudgeSet: number;
  rows: { id: number; site: string; inlier: number; reliability: number; gain: number; pickedAt: number }[];
  /** For Search AI's learner: per source, ads delivered and inlier mass (sum of r_i). Feed to updateBelief. */
  sourceEvidence: { site: string; n: number; inlierMass: number }[];
}

// ---------------------------------------------------------------- the selection

export function analyzeFindings(all: Ad[], opts: SelectOptions = {}): { chosen: Finding[]; trace: SelectionTrace } {
  const n = all.length;
  const max = Math.max(1, Math.min(opts.max ?? MAX_FINDINGS, Math.max(1, n)));
  const slots = Math.min(max, Math.max(1, opts.judgeSlots ?? JUDGE_MAX_ADS));
  if (n === 0) return { chosen: [], trace: { muLog: 0, scale: 1, infoJudgeSet: 0, sdLogJudgeSet: Infinity, rows: [], sourceEvidence: [] } };

  const priced = all.map((f) => Number.isFinite(f.priceUsd) && f.priceUsd > 0);
  const z = all.map((f, i) => (priced[i] ? Math.log(f.priceUsd) - (f.kind === "sold" ? 0 : ASKING_OFFSET) : NaN));
  const sigma = all.map((f) => SIGMA_KIND[f.kind === "sold" ? "sold" : "asking"] * (TIER_INFLATION[f.tier] ?? 1.6));
  const rel = all.map((f) => Math.min(0.995, Math.max(0.05, reliabilityOf(opts.belief?.(f) ?? DEFAULT_BELIEF(f.kind)))));

  // ---- 2. EM on the contaminated normal: mu, scale c, inlier probability r_i
  const idx = z.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0);
  let mu = idx.length ? median(idx.map((i) => z[i])) : 0;
  let c = 1;
  const r = all.map((_, i) => (priced[i] ? rel[i] : 0.3));
  if (idx.length >= 3) {
    for (let it = 0; it < EM_ITERATIONS; it++) {
      for (const i of idx) {
        const pIn = rel[i] * normPdf(z[i] - mu, c * sigma[i]);
        const pOut = (1 - rel[i]) * normPdf(z[i] - mu, TAU_OUT);
        r[i] = pIn / (pIn + pOut + 1e-300);
      }
      let wSum = 0;
      let wz = 0;
      for (const i of idx) {
        const w = r[i] / (c * sigma[i]) ** 2;
        wSum += w;
        wz += w * z[i];
      }
      if (wSum > 0) mu = wz / wSum;
      let num = 0;
      let den = 0;
      for (const i of idx) {
        num += r[i] * ((z[i] - mu) / sigma[i]) ** 2;
        den += r[i];
      }
      if (den > 1e-9) c = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.sqrt(num / den)));
    }
  }

  // ---- 3. error covariance
  const words = all.map((f) => wordsOf(f.title));
  const v = all.map((_, i) => (priced[i] ? (c * sigma[i]) ** 2 / (Math.max(r[i], 0.02) * rel[i]) : UNPRICED_SD ** 2));
  const cov = (i: number, j: number): number => {
    if (i === j) return v[i] + TAU_SITE ** 2 + TAU_SEARCH ** 2 + TAU_TITLE ** 2;
    return (all[i].site === all[j].site ? TAU_SITE ** 2 : 0) + (all[i].searchId === all[j].searchId ? TAU_SEARCH ** 2 : 0) + TAU_TITLE ** 2 * jaccard(words[i], words[j]);
  };

  // ---- 4. greedy A-optimal design with an incrementally updated inverse of Sigma_S
  const picks: number[] = [];
  const gains: number[] = [];
  let inv: number[][] = [];
  let info = 0;
  let infoAtSlots = 0;
  const left = new Set<number>(all.map((_, i) => i));
  while (picks.length < max && left.size > 0) {
    let best = -1;
    let bestGain = -Infinity;
    let bestA: number[] = [];
    let bestD2 = 1;
    for (const j of left) {
      const s = picks.map((p) => cov(p, j));
      const a = inv.map((row) => row.reduce((acc, x, m) => acc + x * s[m], 0));
      const d2 = Math.max(1e-12, cov(j, j) - s.reduce((acc, x, m) => acc + x * a[m], 0));
      const q = 1 - a.reduce((acc, x) => acc + x, 0);
      const gain = (q * q) / d2;
      if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && j < best)) {
        best = j;
        bestGain = gain;
        bestA = a;
        bestD2 = d2;
      }
    }
    // block-inverse update: Sigma_{S+j}^-1
    const k = picks.length;
    const next: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let p = 0; p < k; p++) {
      for (let q2 = 0; q2 < k; q2++) next[p][q2] = inv[p][q2] + (bestA[p] * bestA[q2]) / bestD2;
      next[p][k] = -bestA[p] / bestD2;
      next[k][p] = -bestA[p] / bestD2;
    }
    next[k][k] = 1 / bestD2;
    inv = next;
    picks.push(best);
    gains.push(bestGain);
    info += bestGain;
    left.delete(best);
    if (picks.length === slots) infoAtSlots = info;
  }
  if (picks.length < slots) infoAtSlots = info;

  // ---- the Judge's slots first, listed sold first (the Judge's prompt says so), then local before foreign, then by pick order
  const head = picks
    .slice(0, slots)
    .map((i, pos) => ({ i, pos }))
    .sort((a, b) => Number(all[b.i].kind === "sold") - Number(all[a.i].kind === "sold") || tierRank(all[a.i].tier) - tierRank(all[b.i].tier) || a.pos - b.pos)
    .map((x) => x.i);
  const order = [...head, ...picks.slice(slots)];
  const chosen: Finding[] = order.map((i, k) => ({ ...all[i], id: k + 1 }));

  const rows = order.map((i, k) => ({ id: k + 1, site: all[i].site, inlier: r[i], reliability: rel[i], gain: gains[picks.indexOf(i)], pickedAt: picks.indexOf(i) + 1 }));
  const bySite = new Map<string, { n: number; inlierMass: number }>();
  all.forEach((f, i) => {
    if (!priced[i]) return;
    const e = bySite.get(f.site) ?? { n: 0, inlierMass: 0 };
    e.n += 1;
    e.inlierMass += r[i];
    bySite.set(f.site, e);
  });
  return {
    chosen,
    trace: {
      muLog: mu,
      scale: c,
      infoJudgeSet: infoAtSlots,
      sdLogJudgeSet: infoAtSlots > 0 ? 1 / Math.sqrt(infoAtSlots) : Infinity,
      rows,
      sourceEvidence: [...bySite.entries()].map(([site, e]) => ({ site, ...e })),
    },
  };
}

/** The ads that go on, numbered 1..n (the ids the Judge refers to). */
export const selectFindings = (all: Ad[], opts: SelectOptions = {}): Finding[] => analyzeFindings(all, opts).chosen;
