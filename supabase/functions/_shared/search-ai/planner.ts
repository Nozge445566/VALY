// the runtime decision.
// It picks WHICH 4 searches to run. It never outputs prices. rng is ALWAYS injected (never Math.random here).
// `sampler` is injectable only so tests can replace the gamma draw with a deterministic stream.

import { posterior, sample, type Posterior, type Rng } from "./bandit.ts";
import {
  fixedCandidates, haikuVariants, identCandidates, learnedSiteCandidates, minedCandidates, mutationCandidates,
  signature, slug, tokens, type Candidate,
} from "./candidates.ts";
import { dataRich, thresholds, tierOfGl } from "./data.ts";
import { cleanFingerprint, contextKeys } from "./fingerprint.ts";
import type { Fingerprint } from "../../value-item/types.ts";
import { countryStat, observations, type Policy } from "./policy.ts";

export const MAX_SEARCHES = 4;
/** Haiku's own query always takes this many of the 4 slots (when Identification gave one). The Search AI fills the rest. */
export const HAIKU_SLOT = 1;
/** Slot 4 variants: a variant may only win the sampling with this many observations of its own (else the exact Haiku query runs). */
export const VARIANT_MIN_OBS = 3;
/** Once Haiku's exact query is established (CONTROL_MIN_OBS), this share of valuations tries a not-yet-tested variant. Assumption. */
export const VARIANT_EXPLORE = 0.1;
export const CONTROL_MIN_OBS = 20;
export const EXPERIMENT_SLOTS = 4;
export const SOLD_TARGET = 5;
export const MAX_MS = 2000;
export const MIN_TOTAL_OBS = 20;
export const MAX_GLOBAL_PLANNED = 2;

export type Sampler = (p: Posterior, rng: Rng) => number;
export type Scored = { candidate: Candidate; score: number; post: Posterior };

export function globalBudget(policy: Policy, fp: Fingerprint): number {
  const country = fp.country;
  if (country === "ZZ") return MAX_SEARCHES;
  const th = thresholds();
  const stat = countryStat(policy, country);
  let thin: boolean;
  let rich: boolean;
  if (stat !== null && stat[1] >= th.country_stats_min_n) {
    thin = stat[0] < th.thin_below_sold_per_search;
    rich = stat[0] >= th.high_sold_per_search;
  } else {
    thin = !dataRich().has(country);
    rich = false;
  }
  return thin || rich ? 0 : MAX_GLOBAL_PLANNED;
}

export class Allowance {
  country: string;
  left: number;
  constructor(fp: Fingerprint, budget: number) {
    this.country = fp.country;
    this.left = budget;
  }
  isGlobal(c: Candidate): boolean {
    return tierOfGl(c.gl, this.country) === "global";
  }
  allows(c: Candidate): boolean {
    return !this.isGlobal(c) || this.left > 0;
  }
  took(c: Candidate): void {
    if (this.isGlobal(c)) this.left -= 1;
  }
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function diverse(c: Candidate, chosen: Candidate[], strict: boolean, maxSim = 0.85): boolean {
  const ct = tokens(c);
  const cs = signature(c);
  for (const o of chosen) {
    const sim = jaccard(ct, tokens(o));
    if (c.query.toLowerCase() === o.query.toLowerCase()) return false;
    const os = signature(o);
    if (strict && cs[0] === os[0] && cs[1] === os[1] && cs[2] === os[2] && sim >= 0.6) return false;
    if (sim >= (strict ? maxSim : 0.95)) return false;
  }
  return true;
}

function pick(
  ranked: Scored[], chosen: Candidate[], picked: Scored[], want: number,
  maxSim = 0.85, relax = true, allowance: Allowance | null = null,
): void {
  for (const strict of relax ? [true, false] : [true]) {
    for (const s of ranked) {
      if (picked.length >= want) return;
      if (picked.includes(s)) continue;
      if (allowance !== null && !allowance.allows(s.candidate)) continue;
      if (diverse(s.candidate, chosen, strict, maxSim)) {
        picked.push(s);
        chosen.push(s.candidate);
        if (allowance !== null) allowance.took(s.candidate);
      }
    }
  }
}

function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of cands) {
    const key = c.query.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// Stable sort, highest score first (same as Python sorted(..., reverse=True)).
const byScoreDesc = (xs: Scored[]): Scored[] => [...xs].sort((a, b) => b.score - a.score);

export function plan(
  policy: Policy, rawFingerprint: unknown, identQueries: unknown, rng: Rng, sampler: Sampler = sample,
): Record<string, unknown> {
  const fp = cleanFingerprint(rawFingerprint);
  if (fp === null) return { ok: false, reason: "bad_input" };
  if (policy.version < 1 || observations(policy) < MIN_TOTAL_OBS) return { ok: false, reason: "no_data" };

  const queries = Array.isArray(identQueries) ? identQueries.filter((q): q is string => typeof q === "string") : [];
  const contexts = contextKeys(fp);
  const score = (c: Candidate): Scored => {
    const post = posterior(policy, contexts, c.templateId);
    return { candidate: c, score: sampler(post, rng), post };
  };

  const pool = dedupe([
    ...fixedCandidates(fp), ...learnedSiteCandidates(policy, fp), ...minedCandidates(policy, fp),
  ]);
  // Haiku's own query is NOT part of the sampled pool: it is always the 4th search (guaranteed slot, see HAIKU_SLOT).
  const haikuControl = identCandidates(queries, fp)[0] ?? null;
  const haikuKey = haikuControl ? haikuControl.query.toLowerCase() : null;
  const poolNoHaiku = haikuKey ? pool.filter((c) => c.query.toLowerCase() !== haikuKey) : pool;
  // Slot 4: Haiku's exact query (control) or one of its variants, chosen by Thompson sampling over ONLY these (own arm ids).
  let haikuScored: Scored | null = null;
  if (haikuControl) {
    const control = score(haikuControl);
    haikuScored = control;
    const variants = haikuVariants(haikuControl, fp).slice(1).map(score);
    if (variants.length > 0) {
      const untried = variants.filter((v) => v.post.nGlobal < VARIANT_MIN_OBS);
      if (control.post.nGlobal >= CONTROL_MIN_OBS && untried.length > 0 && rng() < VARIANT_EXPLORE) {
        haikuScored = untried[Math.min(untried.length - 1, Math.floor(rng() * untried.length))];
      } else {
        for (const v of variants) if (v.post.nGlobal >= VARIANT_MIN_OBS && v.score > haikuScored.score) haikuScored = v;
      }
    }
  }
  const haikuCand = haikuScored ? haikuScored.candidate : null;
  const budget = globalBudget(policy, fp);
  const allowance = new Allowance(fp, budget);
  const scored = byScoreDesc(poolNoHaiku.map(score));

  // All four searches are experiments: Thompson sampling over the whole pool (learned, fixed, ident AND mutations),
  // and every one of them is logged and learned from. Sampling itself balances trying new and proven queries.
  const taken = new Set([...pool.map((c) => c.query.toLowerCase()), ...(haikuKey ? [haikuKey] : [])]);
  const mutations = mutationCandidates(fp).filter((m) => !taken.has(m.query.toLowerCase()));
  const all = byScoreDesc([...scored, ...mutations.map(score)]);
  const chosen: Candidate[] = [];
  const picked: Scored[] = [];
  const want = haikuCand ? MAX_SEARCHES - HAIKU_SLOT : MAX_SEARCHES; // Search AI picks 3, Haiku gives the 4th
  if (haikuCand) {
    chosen.push(haikuCand); // the other three must differ from Haiku's query
    allowance.took(haikuCand);
  }
  pick(all, chosen, picked, want, 0.85, true, allowance);
  if (picked.length < want && budget === 0) {
    // never leave the plan short: allow one global search if nothing else is left
    pick(all, chosen, picked, want, 0.95, false, new Allowance(fp, 1));
  }
  if (haikuScored) picked.push(haikuScored); // Haiku's slot is always the last of the four

  const searches: Array<["experiment", Scored]> = picked.map((s) => ["experiment", s] as ["experiment", Scored]).slice(0, MAX_SEARCHES);
  if (searches.length === 0) return { ok: false, reason: "no_data" };

  return {
    ok: true,
    strategy_version: policy.version,
    searches: searches.map(([kind, s], i) => ({
      id: `s${i + 1}`,
      query: s.candidate.query,
      template_id: slug(s.candidate.templateId),
      kind,
      gl: s.candidate.gl,
      hl: s.candidate.hl,
      tier: tierOfGl(s.candidate.gl, fp.country),
    })),
    stop: { sold_prices: SOLD_TARGET, max_ms: MAX_MS },
  };
}
