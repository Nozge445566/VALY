// The Connector's deeper system, as pure maths. No network, no database:
// the Edge Function `connector-learn` feeds it rows and stores what it returns; tests run it with made-up rows.
//
// WHAT IT LEARNS. One number per bucket (country | category | plan source, and the parents country|category and country):
// the DIAL, 0..1. It answers "does rule R1 help in this bucket?". The fast part (connector.ts) scales the treated share by
// the dial, never above the share the owner chose and never below a small floor, so learning can recover. A dial of 1
// is "the owner's share as is", a dial near 0 is "almost switched off here".
//
// HOW IT LEARNS. Reward per valuation and per rule = the score of ONLY the searches that rule edits (R1: the local template
// searches, RG: the global ones, RH: Haiku's own), measured against the median of ALL sold prices of the valuation. The
// other searches of the valuation are not part of that score: they are not touched by the rule, so they would only add
// noise. Treated valuations are compared with unmodified ones from the same bucket and the same period (the control
// group), only among valuations where the rule had something to change. A one-sided Welch test turns the difference into
// a z score. A dial only ever goes DOWN, and only when the rule is shown to HURT: z must be below minus the threshold of
// `zNeeded(m)`, which is corrected for the number m of tests made that night (Bonferroni, FAMILY_ALPHA). Anything weaker
// than that is luck and moves nothing: the dial relaxes back toward 1 (the product rule's share as is). One night can move a
// dial by DIAL_MAX_STEP at most: fine-tune, never rebuild. Too little data = no row (nothing learned).

// ALL FOUR SEARCHES (added 1 Nov 2026, after the owner's picture). Two directions, both learned:
//   IN  (thick line): how strongly Haiku's search counts when a valuation is scored. Starts at the prior HAIKU_LINK_WEIGHT
//       (1.375, the other three count 1). `learnHaikuWeights` may move it per bucket, but only inside
//       [HAIKU_WEIGHT_MIN, HAIKU_WEIGHT_MAX], only HAIKU_WEIGHT_MAX_STEP per night, only with enough data, and always
//       shrunk toward the prior. The other three keep weight 1.
//   OUT (calibration): every kind of search has its OWN rule and its OWN dial: R1 = local template searches,
//       RG = global template searches, RH = Haiku's own search. `learnPolicy` compares each rule with its own control
//       group separately (independent random draws per rule), so one rule can never hide behind another.
// Dials of R1 keep the old key (the bucket itself); RG and RH use `RG@bucket` and `RH@bucket` (see policyKey).

export const HAIKU_LINK_WEIGHT = 1.375;
/** OWNER (3 Nov 2026): the three other searches weigh 100 each (=300); Haiku's weighs 125-150 (weight 1.25-1.5 vs 1). Haiku is a bit stronger, never heavy. */
export const HAIKU_WEIGHT_MIN = 1.25;
export const HAIKU_WEIGHT_MAX = 1.5;
/** A bucket needs this many unmodified valuations (Haiku and at least one other search answered) before its weight moves. */
export const WEIGHT_MIN_N = 30;
/** Shrinks the observed Haiku-versus-others ratio toward 1: with this many valuations the data counts half. */
export const WEIGHT_SHRINK_N = 60;
/** One night may move a weight by this much at most. */
export const HAIKU_WEIGHT_MAX_STEP = 0.05;

export type ConnectorRuleId = "R1" | "RG" | "RH";
export const CONNECTOR_RULE_IDS: readonly ConnectorRuleId[] = ["R1", "RG", "RH"];

/** The key of a dial in l_connector_policy. R1 keeps the plain bucket (older rows stay valid); the others get a prefix. */
export function policyKey(rule: string, bucket: string): string {
  return rule === "R1" ? bucket : `${rule}@${bucket}`;
}
/** The key of a learned Haiku weight inside the policy map that value-item loads (the table itself stores the plain bucket). */
export function weightKey(bucket: string): string {
  return `W@${bucket}`;
}

export function clampHaikuWeight(w: number): number {
  return Number.isFinite(w) ? Math.min(HAIKU_WEIGHT_MAX, Math.max(HAIKU_WEIGHT_MIN, w)) : HAIKU_LINK_WEIGHT;
}

/** The learned Haiku weight for a bucket: the most specific one that exists, else the prior. Always inside the safe range. */
export function haikuWeightFor(table: ReadonlyMap<string, number> | undefined, bucket: string): number {
  if (!table) return HAIKU_LINK_WEIGHT;
  for (const b of levels(bucket)) {
    const w = table.get(weightKey(b));
    if (w !== undefined && Number.isFinite(w)) return clampHaikuWeight(w);
  }
  return HAIKU_LINK_WEIGHT;
}
/** A discarded hit (the Judge said "not the same item") costs this much of a kept sold price. An assumption. */
export const DISCARD_PENALTY = 0.25;
/** Each arm (treated, control) needs this many valuations in a bucket before the dial moves. Same size as COUNTRY_STATS_MIN_N. */
export const MIN_N_PER_ARM = 30;
/** One night may move a dial by this much at most. */
export const DIAL_MAX_STEP = 0.25;
/**
 * How often a whole night of tests may brake a rule by luck alone (one-sided, shared by ALL tests of the night). With m tests
 * each one must pass at FAMILY_ALPHA / m (Bonferroni). Strict on purpose: a wrongly braked rule only loses some benefit, but a
 * dial that chases noise teaches the system nothing. An assumption: tune with real data.
 */
export const FAMILY_ALPHA = 0.05;

/** Inverse of the standard normal CDF (Acklam's rational approximation, error below 1.2e-9). p must be in (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** The z a rule must fall BELOW (as minus this number) before its dial may go down, when `m` tests are made at once. */
export function zNeeded(m: number): number {
  return normalQuantile(1 - FAMILY_ALPHA / Math.max(1, Math.trunc(m)));
}

export interface RewardSearch {
  weight: number;
  /** Reward v2: sold prices (usd) this search found. Present = price-accuracy reward; absent = legacy kept_sold reward (old rows). */
  prices?: readonly number[];
  /** Same order and length as `prices`: salted key of each listing (comparable only inside one valuation). Absent on older rows. */
  price_keys?: readonly string[];
  latency_ms?: number;
  kept_sold: number;
  discarded: number;
  cancelled: boolean;
  failed: boolean;
}

// ---- Reward v2 (3 Nov 2026): same idea as search-ai/learner.ts. Price correctness vs the valuation's pooled median,
// count worth at most COUNT_SHARE, speed at most SPEED_SHARE. The Judge is not read when `prices` exist.
export const V2_SOLD_CAP = 5;
export const V2_PRICE_TOLERANCE = 0.5;
export const V2_COUNT_SHARE = 0.3;
export const V2_SPEED_SHARE = 0.15;
export const V2_UNVERIFIED_SCORE = 0.4;

function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const cleanPrices = (x: readonly number[] | undefined): number[] =>
  (x ?? []).filter((p) => Number.isFinite(p) && p > 0).slice(0, V2_SOLD_CAP);
/** A search's own sold prices with their listing keys (null = no key known), cleaned and capped exactly like cleanPrices. */
function pricedOf(s: { prices?: readonly number[]; price_keys?: readonly string[] }): { usd: number; key: string | null }[] {
  const keys = Array.isArray(s.price_keys) && s.price_keys.length === (s.prices ?? []).length ? s.price_keys : null;
  return (s.prices ?? [])
    .map((usd, i) => ({ usd, key: keys && typeof keys[i] === "string" ? keys[i] : null }))
    .filter((p) => Number.isFinite(p.usd) && p.usd > 0)
    .slice(0, V2_SOLD_CAP);
}
/** All prices of the given searches as one list in which one listing counts ONCE (when keys are known): two searches that found the same listing do not count it twice. */
function pooledPrices(searches: readonly { prices?: readonly number[]; price_keys?: readonly string[] }[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const s of searches) {
    for (const p of pricedOf(s)) {
      if (p.key !== null) {
        if (seen.has(p.key)) continue;
        seen.add(p.key);
      }
      out.push(p.usd);
    }
  }
  return out;
}
function speedOf(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return 0.5;
  const t = Math.min(2.5, Math.max(0.2, ms / 1000));
  return 1 - (t - 0.2) / 2.3;
}
/** Score 0..1 of one search. A search with no sold price scores 0. Null median = unverifiable (UNVERIFIED_SCORE). */
export function scoreSearchV2(s: RewardSearch, median: number | null): number {
  const sold = cleanPrices(s.prices);
  if (sold.length === 0) return 0;
  const accuracy = median === null
    ? V2_UNVERIFIED_SCORE
    : sold.reduce((a, p) => a + Math.max(0, 1 - Math.abs(Math.log(p / median)) / Math.log(1 + V2_PRICE_TOLERANCE)), 0) / sold.length;
  const core = accuracy * (1 - V2_COUNT_SHARE + V2_COUNT_SHARE * (sold.length / V2_SOLD_CAP));
  return core * (1 - V2_SPEED_SHARE + V2_SPEED_SHARE * speedOf(s.latency_ms));
}

const isLive = (s: RewardSearch) => !s.cancelled && !s.failed;

/**
 * Weighted score of the searches `mine`, with the market median taken from ALL searches of the valuation (`pool`).
 * Cancelled and failed searches carry no information and are left out. Null = nothing to score.
 * If any search of the pool carries `prices` the v2 price-accuracy reward is used (median over all pooled sold prices of the
 * valuation, <2 prices total = unverified). Otherwise the legacy kept_sold reward is used so old log rows keep working.
 * Note: the legacy branch and DISCARD_PENALTY can be removed once old rows have aged out of the learning window.
 */
export function rewardOfSearches(pool: readonly RewardSearch[], mine: readonly RewardSearch[]): number | null {
  const livePool = pool.filter(isLive);
  const liveMine = mine.filter(isLive);
  const v2 = livePool.some((s) => Array.isArray(s.prices));
  let sum = 0;
  let w = 0;
  if (v2) {
    const all = pooledPrices(livePool);
    const med = all.length >= 2 ? medianOf(all) : null;
    for (const s of liveMine) {
      const weight = Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 1;
      sum += weight * scoreSearchV2(s, med);
      w += weight;
    }
  } else {
    for (const s of liveMine) {
      const weight = Number.isFinite(s.weight) && s.weight > 0 ? s.weight : 1;
      sum += weight * (Math.max(0, s.kept_sold) - DISCARD_PENALTY * Math.max(0, s.discarded));
      w += weight;
    }
  }
  return w > 0 ? Math.round((sum / w) * 10000) / 10000 : null;
}

/** Weighted score of a whole valuation (every search is `mine`). This is the number stored as `reward` in l_connector_log. */
export function rewardOf(searches: readonly RewardSearch[]): number | null {
  return rewardOfSearches(searches, searches);
}

/** One entry of l_connector_log.searches, as far as the learner needs it. */
export interface LearnSearch {
  rule: string | null;
  /** False = the rule was not allowed to act (not switched on, or blocked): the entry is left out of learning. Missing = allowed (older rows). */
  rule_on?: boolean | null;
  original_query: string;
  executed_query: string;
  is_haiku: boolean;
  kept_sold: number;
  discarded: number;
  /** Reward v2 inputs (sold prices usd, latency). Absent on old rows. */
  prices?: readonly number[];
  /** Listing key of each price, same order (race-free credit, 4 Nov 2026). Absent on older rows. */
  price_keys?: readonly string[];
  latency_ms?: number;
  cancelled: boolean;
  failed: boolean;
}

/** The part of an l_connector_log row the learner needs. Rows with `searches` are read per rule; older rows (no `searches`) count as R1 only. */
export interface LogRowForLearning {
  mode: string;
  applied: boolean;
  proposed_changes: number;
  bucket: string;
  judge_ok: boolean;
  reward: number | null;
  searches?: readonly LearnSearch[];
}

/** v2 rows (searches carry `prices`) never need the Judge; legacy rows still need judge_ok. */
export function usableRow(r: LogRowForLearning): boolean {
  return r.judge_ok || (r.searches ?? []).some((x) => Array.isArray(x.prices));
}

const asRewardSearch = (x: LearnSearch, haikuWeight: number): RewardSearch => ({
  weight: x.is_haiku ? haikuWeight : 1,
  kept_sold: x.kept_sold,
  discarded: x.discarded,
  prices: x.prices,
  price_keys: x.price_keys,
  latency_ms: x.latency_ms,
  cancelled: x.cancelled,
  failed: x.failed,
});

/**
 * Score of the searches `mine` (the ones ONE rule edits) inside the valuation `all`, with ONE common Haiku weight so rows
 * from different nights stay comparable. Only `mine` is scored; `all` only supplies the market median. Pass the same list
 * twice to get the score of the whole valuation.
 */
export function rewardWithHaikuWeight(all: readonly LearnSearch[], mine: readonly LearnSearch[], haikuWeight: number): number | null {
  return rewardOfSearches(all.map((x) => asRewardSearch(x, haikuWeight)), mine.map((x) => asRewardSearch(x, haikuWeight)));
}

export interface Arm {
  n: number;
  mean: number;
  variance: number;
}

function arm(values: number[]): Arm {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, variance };
}

/** Welch z for treated minus control. Null when an arm is too small or there is no spread at all. */
export function welchZ(t: Arm, c: Arm): { lift: number; z: number } | null {
  if (t.n < MIN_N_PER_ARM || c.n < MIN_N_PER_ARM) return null;
  const se = Math.sqrt(t.variance / t.n + c.variance / c.n);
  const lift = t.mean - c.mean;
  if (!(se > 0)) return lift === 0 ? { lift, z: 0 } : null; // identical numbers everywhere: nothing to learn from
  return { lift, z: lift / se };
}

/**
 * The dial a rule is aiming for, given its z score and the z it needs (`zNeeded(m)`): 0 only when it is shown to HURT
 * (z at or below minus the need), otherwise 1. A rule is never rewarded with more than the owner's share, so "helps" and
 * "no proof either way" are the same thing here: leave it at 1.
 */
export function dialTarget(z: number, need: number): number {
  return z <= -need ? 0 : 1;
}

/** Moves `from` toward `to` by at most DIAL_MAX_STEP. */
export function stepToward(from: number, to: number): number {
  const d = Math.max(-DIAL_MAX_STEP, Math.min(DIAL_MAX_STEP, to - from));
  return Math.round(Math.min(1, Math.max(0, from + d)) * 10000) / 10000;
}

export interface PolicyRow {
  bucket: string;
  dial: number;
  n_treated: number;
  n_control: number;
  lift: number;
  z: number;
}

/** `country|category|source` -> itself, `country|category`, `country`. Every valuation counts at each level. */
function levels(bucket: string): string[] {
  const parts = bucket.split("|");
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) out.push(parts.slice(0, n).join("|"));
  return out;
}

/**
 * The learned table. Only mode-on rows where the price reward can be computed count, and per rule only rows where THAT rule
 * had a proposal and was allowed to act. Treated = the rule's search really ran changed, control = it ran unmodified (the
 * owner's control group and the valuations the dial held back; both are random draws, one draw per rule). The reward of
 * a rule is the score of ONLY the searches it edits (see the header).
 * Shadow rows are not used here (they come from an earlier period): they are for the human review.
 * Many buckets are tested at once, so a dial only goes down when z is below minus `zNeeded(m)` with m = the tests of this
 * night; otherwise the dial relaxes toward 1. `previous` is last night's table (keys as in policyKey); a dial only moves
 * DIAL_MAX_STEP from it (a new key starts from 1).
 * `haikuWeightOf` gives the Haiku weight for a bucket (default: the prior); it applies if Haiku's search is among the
 * searches being scored.
 */
export function learnPolicy(
  rows: readonly LogRowForLearning[],
  previous: ReadonlyMap<string, number> = new Map(),
  haikuWeightOf: (bucket: string) => number = () => HAIKU_LINK_WEIGHT,
): PolicyRow[] {
  const treated = new Map<string, number[]>();
  const control = new Map<string, number[]>();
  const add = (rule: string, bucket: string, isTreated: boolean, reward: number) => {
    for (const b of levels(bucket)) {
      const key = policyKey(rule, b);
      const target = isTreated ? treated : control;
      const list = target.get(key) ?? [];
      list.push(reward);
      target.set(key, list);
    }
  };
  for (const r of rows) {
    if (r.mode !== "on" || !usableRow(r)) continue;
    if (r.searches && r.searches.length > 0) {
      const haikuWeight = clampHaikuWeight(haikuWeightOf(r.bucket));
      const byRule = new Map<string, LearnSearch[]>();
      for (const x of r.searches) {
        if (!x.rule || x.rule_on === false) continue;
        byRule.set(x.rule, [...(byRule.get(x.rule) ?? []), x]);
      }
      for (const [rule, mine] of byRule) {
        const reward = rewardWithHaikuWeight(r.searches, mine, haikuWeight);
        if (reward === null || !Number.isFinite(reward)) continue; // none of this rule's searches answered: no information
        add(rule, r.bucket, mine.some((x) => x.executed_query !== x.original_query), reward);
      }
      continue;
    }
    if (r.reward === null || !Number.isFinite(r.reward) || r.proposed_changes < 1) continue; // older rows: R1 only
    add("R1", r.bucket, r.applied, r.reward);
  }
  const tests: { key: string; t: number[]; c: number[]; lift: number; z: number }[] = [];
  for (const [key, t] of treated) {
    const c = control.get(key) ?? [];
    const res = welchZ(arm(t), arm(c));
    if (res) tests.push({ key, t, c, lift: res.lift, z: res.z });
  }
  const need = zNeeded(tests.length);
  const out: PolicyRow[] = tests.map(({ key, t, c, lift, z }) => ({
    bucket: key,
    dial: stepToward(previous.get(key) ?? 1, dialTarget(z, need)),
    n_treated: t.length,
    n_control: c.length,
    lift: Math.round(lift * 10000) / 10000,
    z: Math.round(z * 1000) / 1000,
  }));
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export interface WeightRow {
  bucket: string;
  haiku_weight: number;
  n: number;
  /** Haiku's mean price-accuracy score divided by the mean score of the other searches (before shrinking). */
  ratio: number;
}

/**
 * Score of one search's own sold prices against what the OTHER answered searches of the same valuation found (leave-one-out,
 * so a search is never graded against itself; one listing found by several searches counts once). Null = no reference
 * (fewer than 2 prices from the others): that search cannot be judged on price.
 */
function scoreAgainstOthers(answered: readonly LearnSearch[], index: number): number | null {
  const reference = pooledPrices(answered.filter((_, i) => i !== index));
  if (reference.length < 2) return null;
  return scoreSearchV2(asRewardSearch(answered[index], 1), medianOf(reference));
}

/**
 * The IN direction (the thick line), learned. For each bucket: how much better (or worse) is Haiku's search than the
 * other searches at finding sold prices that are CORRECT for the same item? "Correct" is the price-accuracy reward of the
 * rules (reward v2: accuracy against the market, count worth at most 30 %, speed at most 15 %), not a count of kept hits.
 * Each search is graded against the median of what the OTHER answered searches of the same valuation found (leave-one-out,
 * one listing counted once), using each search's own sold prices, including listings another search happened to deliver
 * first, so the result does not depend on which parallel search was a few milliseconds faster.
 * Only rows that carry sold prices (reward v2) count: older rows that only hold kept_sold counts are left out, because a
 * count and a price score cannot be mixed in one ratio. Only valuations where nothing was modified count (shadow rows and
 * unmodified on-rows), so the Connector's own changes cannot bend its own weight. The ratio is shrunk toward 1 with
 * WEIGHT_SHRINK_N, scaled from the prior, clamped to [HAIKU_WEIGHT_MIN, HAIKU_WEIGHT_MAX], and moves at most
 * HAIKU_WEIGHT_MAX_STEP per night. Too little data = no row = the prior stays. `previous` is last night's weights (plain buckets).
 */
export function learnHaikuWeights(rows: readonly LogRowForLearning[], previous: ReadonlyMap<string, number> = new Map()): WeightRow[] {
  const acc = new Map<string, { n: number; h: number; o: number }>();
  for (const r of rows) {
    if (!r.searches || r.searches.length === 0) continue;
    if (!r.searches.some((x) => Array.isArray(x.prices))) continue; // legacy row (counts only): cannot be scored on price
    if (r.searches.some((x) => x.executed_query !== x.original_query)) continue; // modified valuation: not a baseline
    const answered = r.searches.filter((x) => !x.cancelled && !x.failed);
    const haikuAt = answered.findIndex((x) => x.is_haiku);
    if (haikuAt < 0 || answered.filter((x) => x.is_haiku).length !== 1 || answered.length < 2) continue;
    const h = scoreAgainstOthers(answered, haikuAt);
    if (h === null) continue; // the others gave no price reference: Haiku cannot be judged on price here
    const otherScores: number[] = [];
    answered.forEach((_, i) => {
      if (i === haikuAt) return;
      const sc = scoreAgainstOthers(answered, i);
      if (sc !== null) otherScores.push(sc);
    });
    if (otherScores.length === 0) continue;
    const o = otherScores.reduce((a, b) => a + b, 0) / otherScores.length;
    for (const b of levels(r.bucket)) {
      const a = acc.get(b) ?? { n: 0, h: 0, o: 0 };
      a.n += 1;
      a.h += h;
      a.o += o;
      acc.set(b, a);
    }
  }
  const out: WeightRow[] = [];
  for (const [bucket, a] of acc) {
    if (a.n < WEIGHT_MIN_N) continue;
    const meanH = a.h / a.n;
    const meanO = a.o / a.n;
    if (!(meanO > 0)) continue; // the others found nothing: no scale to compare against
    const ratio = Math.max(0, meanH / meanO);
    const shrunk = 1 + (ratio - 1) * (a.n / (a.n + WEIGHT_SHRINK_N));
    const target = clampHaikuWeight(HAIKU_LINK_WEIGHT * shrunk);
    const start = clampHaikuWeight(previous.get(bucket) ?? HAIKU_LINK_WEIGHT);
    const moved = start + Math.max(-HAIKU_WEIGHT_MAX_STEP, Math.min(HAIKU_WEIGHT_MAX_STEP, target - start));
    out.push({ bucket, haiku_weight: Math.round(clampHaikuWeight(moved) * 10000) / 10000, n: a.n, ratio: Math.round(ratio * 1000) / 1000 });
  }
  return out.sort((a, b) => a.bucket.localeCompare(b.bucket));
}

/**
 * Keeps only what the learner needs from l_connector_log.searches (drops hit_keys and the rest). A bad entry is skipped.
 * `prices` and `price_keys` are cleaned TOGETHER: a price that is dropped as invalid takes its key with it, so the two
 * lists stay the same length and order. Keys are left out when they cannot be matched to the prices.
 */
export function slimLearnSearches(raw: unknown): LearnSearch[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: LearnSearch[] = [];
  for (const x of raw as Array<Record<string, unknown>>) {
    if (!x || typeof x !== "object") continue;
    let prices: number[] | undefined;
    let price_keys: string[] | undefined;
    if (Array.isArray(x.prices)) {
      const rawPrices = x.prices as unknown[];
      const rawKeys = Array.isArray(x.price_keys) && (x.price_keys as unknown[]).length === rawPrices.length ? (x.price_keys as unknown[]) : null;
      prices = [];
      const keys: string[] = [];
      rawPrices.forEach((p, i) => {
        const n = Number(p);
        if (!Number.isFinite(n) || !(n > 0)) return;
        prices!.push(n);
        keys.push(rawKeys && typeof rawKeys[i] === "string" ? (rawKeys[i] as string) : "");
      });
      if (rawKeys && keys.every((k) => k !== "")) price_keys = keys;
    }
    out.push({
      rule: typeof x.rule === "string" ? x.rule : null,
      rule_on: typeof x.rule_on === "boolean" ? x.rule_on : null,
      original_query: String(x.original_query ?? ""),
      executed_query: String(x.executed_query ?? ""),
      is_haiku: x.is_haiku === true,
      kept_sold: Number(x.kept_sold) || 0,
      discarded: Number(x.discarded) || 0,
      prices,
      ...(price_keys ? { price_keys } : {}),
      latency_ms: Number.isFinite(Number(x.latency_ms)) ? Number(x.latency_ms) : undefined,
      cancelled: x.cancelled === true,
      failed: x.failed === true,
    });
  }
  return out;
}
