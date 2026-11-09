// the nightly learner. Pure functions over log rows.
// Python traps handled: Unicode \w -> \p{L}\p{N}_ with u flag, code point lengths, Python round() is half-even,
// Python truthiness / str(None), stable sorts with Python key semantics, null not undefined, no Math.random.
// Time: parseTime returns epoch milliseconds (fractional, so microseconds survive). `now` is a Date (UTC).

import { createHash } from "node:crypto";
import { posterior, posteriorMean } from "./bandit.ts";
import { marketplaces, tierOfGl } from "./data.ts";
import { cleanFingerprint, contextKeys } from "./fingerprint.ts";
import { DEFAULT_PRIOR_RATE, DEFAULT_PRIOR_STRENGTH, observations, type Policy, type Stat, type SiteStat } from "./policy.ts";

export const HALF_LIFE_DAYS = 14.0;
export const MIN_SECONDS = 0.2;
export const MAX_SECONDS = 2.5;
export const MIN_ROWS_TO_LEARN = 20;
export const MIN_WINS = 3;
export const MAX_TEMPLATES = 60;
export const SITES_PER_COUNTRY = 3;
export const MIN_SITE_SEARCHES = 3;
export const MIN_SITE_KEPT = 1.0;
export const HOLDOUT_DAYS = 3;
export const MIN_HOLDOUT_GROUPS = 20;
export const REPLAY_TOLERANCE = 0.02;
export const DRIFT_RATIO = 0.6;
export const DRIFT_MIN_ROWS = 30;
export const BASELINE_DAYS = 14;

const DAY_MS = 86400000;

export type Row = Record<string, unknown>;

// ---------------------------------------------------------------- Python helpers

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** Python truthiness. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return !(typeof v === "number" && Number.isNaN(v) === false && v === 0);
}
/** float(row.get(key) or 0) */
function pyFloat(v: unknown): number {
  if (!truthy(v)) return 0;
  if (typeof v === "string" && v.trim() === "") throw new Error("could not convert string to float");
  const x = Number(v);
  if (Number.isNaN(x)) throw new Error("could not convert to float");
  return x;
}
/** str(x) for the cases a log row can hold. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}
/** str(row.get(key) or dflt) */
function strOr(v: unknown, dflt: string): string {
  return truthy(v) ? pyStr(v) : dflt;
}
const cpLen = (s: string): number => Array.from(s).length;
function cmpCp(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
/** Python round(x, n): exact decimal value, ties to even. */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const a = Math.abs(x);
  const full = a.toFixed(100);
  const dot = full.indexOf(".");
  const kept = full.slice(0, dot + 1 + n);
  const tail = full.slice(dot + 1 + n);
  let res: string;
  if (/^50*$/.test(tail)) {
    const last = Number(kept.replace(".", "").slice(-1));
    res = last % 2 === 0 ? kept : a.toFixed(n);
  } else {
    res = a.toFixed(n);
  }
  const v = Number(res);
  return neg ? -v : v;
}
const PY_WS = "[\\t-\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const WS_RUN = new RegExp(PY_WS + "+", "gu");
const WS_EDGE = new RegExp("^" + PY_WS + "+|" + PY_WS + "+$", "gu");
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** datetime.isoformat() for a UTC time: microseconds only when not zero. */
export function isoformat(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const ms = d.getUTCMilliseconds();
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    (ms ? `.${p(ms, 3)}000` : "") +
    "+00:00"
  );
}

/** learner.parse_time -> epoch milliseconds. Naive times are UTC. Throws on bad input (like Python). */
export function parseTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const text = pyStr(value).replace("Z", "+00:00");
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d)(?::(\d\d)(?::(\d\d)(?:[.,](\d+))?)?)?)?\s*(?:([+-])(\d\d)(?::?(\d\d))?)?$/.exec(text);
  if (!m) throw new Error(`Invalid isoformat string: '${text}'`);
  const frac = m[7] ? Number("0." + m[7].slice(0, 6)) * 1000 : 0;
  let ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) + frac;
  if (m[8]) {
    const off = (Number(m[9]) * 60 + Number(m[10] ?? 0)) * 60000;
    ms -= m[8] === "+" ? off : -off;
  }
  return ms;
}

/**
 * Judge-free: a row is usable when it has an item fingerprint, a template and the live-market price list.
 * A row whose query was edited after planning (`connector_modified`, written by the live pipeline) is NOT usable: its prices
 * belong to the edited query, not to the template, so crediting them to the template would mix two different things. The
 * row stays in `prepare` (its prices still help to find the market median of the valuation), it just earns the template
 * nothing. The edit itself is judged by the Connector, from its own log.
 */
export function usable(row: Row): boolean {
  // "eyes_evidence" is the Authenticity-eye search Market Live adds in a thin market: it is not a template, so it earns no
  // template credit, no mined pattern and no country statistic. Its prices still pool into the market median (prepare).
  return isDict(row.fingerprint) && truthy(row.template_id) && pyStr(row.template_id) !== "eyes_evidence" && Array.isArray(row.prices) && row.connector_modified !== true;
}

// ---------------------------------------------------------------- reward (v2: price correctness, Judge-free)
// The reward is how CORRECT the sold prices of a search are, measured only against the live market:
// each sold price is compared with the median sold price of the whole valuation (all searches pooled).
// The Judge's keep/discard verdicts are never read. Finding many prices earns nothing extra (capped at SOLD_CAP).
// Credit is race-free since 4 Nov 2026: a search is scored on `own_sold` (all sold prices it found itself), not on `prices`
// (each listing once, first delivery). The median below still pools `prices`, so each listing counts once there.
// Speed is a small, capped factor (at most SPEED_SHARE of the score) so a fast site cannot beat a better one.
export const SOLD_CAP = 5;
export const PRICE_TOLERANCE = 0.5; // a price 50% away from the market median scores 0
export const COUNT_SHARE = 0.3; // part of the score that grows with the number of sold prices, saturating at SOLD_CAP
export const SPEED_SHARE = 0.15; // part of the score that depends on speed
export const UNVERIFIED_SCORE = 0.4; // sold prices exist but the valuation has no second price to compare with
export const WIN_SCORE = 0.6;

const SCORES = new WeakMap<Row, number>();

function soldPrices(row: Row): number[] {
  if (!Array.isArray(row.prices)) return [];
  const out: number[] = [];
  for (const p of row.prices) {
    if (isDict(p) && p.kind === "sold") {
      const usd = Number(p.usd);
      if (Number.isFinite(usd) && usd > 0) out.push(usd);
    }
  }
  return out.slice(0, SOLD_CAP);
}

/**
 * The sold prices a search is CREDITED for (its score, and the country statistic). Since 4 Nov 2026 the live pipeline writes
 * `own_sold`: what the search found ITSELF, also listings another parallel search delivered first (those are missing from
 * `prices`, which holds each listing once for the Judge). When `own_sold` is an array it replaces `prices` here, so credit no
 * longer depends on which search answered a few milliseconds earlier. Missing or null (old rows, failed or cancelled searches):
 * the old path, `soldPrices`, runs unchanged.
 * The market median still pools `soldPrices` (each listing once), never this, so duplicates cannot weigh the median.
 */
function creditPrices(row: Row): number[] {
  if (!Array.isArray(row.own_sold)) return soldPrices(row);
  const out: number[] = [];
  for (const p of row.own_sold) {
    if (typeof p === "number" && Number.isFinite(p) && p > 0) out.push(p);
  }
  return out.slice(0, SOLD_CAP);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Speed factor 0..1 (1 = fastest). */
export function speedFactor(latencyMs: number): number {
  const t = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, latencyMs / 1000.0));
  return 1 - (t - MIN_SECONDS) / (MAX_SECONDS - MIN_SECONDS);
}

/** Score 0..1 of one search against the market median of its valuation (null median: unverifiable). */
export function scoreSearch(row: Row, marketMedian: number | null): number {
  const sold = creditPrices(row);
  if (sold.length === 0) return 0;
  let accuracy: number;
  if (marketMedian === null) {
    accuracy = UNVERIFIED_SCORE;
  } else {
    const per = sold.map((p) => Math.max(0, 1 - Math.abs(Math.log(p / marketMedian)) / Math.log(1 + PRICE_TOLERANCE)));
    accuracy = per.reduce((a, b) => a + b, 0) / per.length;
  }
  const count = Math.min(sold.length, SOLD_CAP) / SOLD_CAP;
  const core = accuracy * (1 - COUNT_SHARE + COUNT_SHARE * count);
  let speed = 0.5;
  try {
    speed = speedFactor(pyFloat(row.latency_ms));
  } catch {
    /* keep neutral speed */
  }
  return core * (1 - SPEED_SHARE + SPEED_SHARE * speed);
}

/** Scores every row once. Rows of one valuation share created_at; their sold prices are pooled for the market median. */
export function prepare(rows: Row[]): void {
  const byGroup = new Map<string, Row[]>();
  for (const r of rows) {
    const key = pyStr(r.created_at);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(r);
  }
  for (const g of byGroup.values()) {
    const pooled = g.flatMap(soldPrices);
    const med = pooled.length >= 2 ? median(pooled) : null;
    for (const r of g) SCORES.set(r, scoreSearch(r, med));
  }
}

/** [score, 1]: score per search (0..1). The second value is a constant 1 so the bandit's rate = mean score. */
export function rewardParts(row: Row): [number, number] {
  let s = SCORES.get(row);
  if (s === undefined) {
    s = scoreSearch(row, null);
    SCORES.set(row, s);
  }
  return [s, 1];
}

/** Live-market sold prices found by one search (Judge-free). Used for country thin/rich statistics only. */
function soldFound(row: Row): number {
  const n = creditPrices(row).length;
  return n || Math.min(SOLD_CAP, Math.max(0, Math.trunc(pyFloat(row.sold_count))));
}

function weight(row: Row, nowMs: number): number {
  const ageDays = Math.max(0.0, (nowMs - parseTime(row.created_at)) / 1000 / 86400.0);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------- template mining

export function slotify(query: string, fp: Record<string, unknown>): string | null {
  let out = query;
  for (const slot of ["model", "brand", "type"]) {
    const value = fp[slot];
    if (truthy(value) && cpLen(String(value)) >= 2) {
      out = out.replace(new RegExp(escapeRe(String(value)), "giu"), () => "{" + slot + "}");
    }
  }
  if (!out.includes("{")) return null;
  out = out.replace(WS_RUN, " ").replace(WS_EDGE, "");
  const n = cpLen(out);
  return n >= 3 && n <= 120 ? out : null;
}

export function marketOf(row: Row, country: string): "local" | "global" {
  const gl = strOr(row.gl, "us").toLowerCase();
  if (gl !== "us") return "local";
  return country.toUpperCase() === "US" ? "local" : "global";
}

export function mineTemplates(rows: Row[], priorRate: number, knownPatterns: Set<string>): Array<Record<string, unknown>> {
  const wins = new Map<string, { pattern: string; market: string; wins: number; rate: number }>();
  for (const r of rows) {
    const [k, t] = rewardParts(r);
    if (k < WIN_SCORE || k / t < priorRate) continue;
    const fp = cleanFingerprint(r.fingerprint);
    if (fp === null) continue;
    const pattern = slotify("query" in r ? pyStr(r.query) : "", fp as unknown as Record<string, unknown>);
    if (pattern === null || knownPatterns.has(pattern)) continue;
    const market = marketOf(r, fp.country);
    const key = JSON.stringify([pattern, market]);
    let stat = wins.get(key);
    if (!stat) {
      stat = { pattern, market, wins: 0, rate: 0.0 };
      wins.set(key, stat);
    }
    stat.wins += 1;
    stat.rate += k / t;
  }
  const mined: Array<Record<string, unknown>> = [];
  for (const { pattern, market, wins: w, rate } of wins.values()) {
    if (w < MIN_WINS) continue;
    const needs = [...new Set([...pattern.matchAll(/\{([\p{L}\p{N}_]+)\}/gu)].map((m) => m[1]))].sort(cmpCp);
    const tid = "mined_" + createHash("sha1").update(`${pattern}|${market}`, "utf8").digest("hex").slice(0, 8);
    mined.push({ id: tid, pattern, market, needs, origin: "mined", wins: Math.trunc(w), avg_rate: pyRound(rate / w, 4) });
  }
  const score = (m: Record<string, unknown>) => (m.wins as number) * (m.avg_rate as number);
  mined.sort((a, b) => score(b) - score(a));
  return mined.slice(0, MAX_TEMPLATES);
}

// ---------------------------------------------------------------- per-country learning

export function isLocalSearch(row: Row, country: string): boolean {
  const tier = row.tier;
  if (tier === "local" || tier === "regional" || tier === "global") return tier === "local";
  return tierOfGl(strOr(row.gl, ""), country) === "local";
}

export function countryStats(rows: Row[], nowMs: number): Record<string, { sold_per_search: number; n: number }> {
  const acc = new Map<string, [number, number, number]>();
  for (const r of rows) {
    if (!usable(r)) continue;
    const fp = cleanFingerprint(r.fingerprint);
    if (fp === null || fp.country === "ZZ" || !isLocalSearch(r, fp.country)) continue;
    const w = weight(r, nowMs);
    let stat = acc.get(fp.country);
    if (!stat) {
      stat = [0.0, 0.0, 0];
      acc.set(fp.country, stat);
    }
    stat[0] += soldFound(r) * w;
    stat[1] += w;
    stat[2] += 1;
  }
  const out: Record<string, { sold_per_search: number; n: number }> = {};
  for (const c of [...acc.keys()].sort(cmpCp)) {
    const s = acc.get(c)!;
    if (s[1] > 0) out[c] = { sold_per_search: pyRound(s[0] / s[1], 4), n: Math.trunc(s[2]) };
  }
  return out;
}

export function mineSites(rows: Row[], nowMs: number): Map<string, SiteStat[]> {
  const acc = new Map<string, { country: string; site: string; gl: string; kept: number; n: number }>();
  for (const r of rows) {
    const site = r.site;
    if (!usable(r) || typeof site !== "string" || !site) continue;
    const fp = cleanFingerprint(r.fingerprint);
    if (fp === null || fp.country === "ZZ") continue;
    const w = weight(r, nowMs);
    const gl = strOr(r.gl, "us").toLowerCase();
    const key = JSON.stringify([fp.country, site.toLowerCase(), gl]);
    let stat = acc.get(key);
    if (!stat) {
      stat = { country: fp.country, site: site.toLowerCase(), gl, kept: 0.0, n: 0 };
      acc.set(key, stat);
    }
    stat.kept += rewardParts(r)[0] * w;
    stat.n += 1;
  }
  const out = new Map<string, SiteStat[]>();
  for (const { country, site, gl, kept, n } of acc.values()) {
    if (n < MIN_SITE_SEARCHES || kept < MIN_SITE_KEPT || marketplaces(country).includes(site)) continue;
    if (!out.has(country)) out.set(country, []);
    out.get(country)!.push({ site, gl, kept: pyRound(kept, 4), n: Math.trunc(n) });
  }
  const sorted = new Map<string, SiteStat[]>();
  for (const country of [...out.keys()].sort(cmpCp)) {
    const lst = out.get(country)!;
    lst.sort((a, b) => {
      const ra = a.kept / a.n;
      const rb = b.kept / b.n;
      if (ra !== rb) return rb - ra;
      return b.n - a.n;
    });
    sorted.set(country, lst.slice(0, SITES_PER_COUNTRY));
  }
  return sorted;
}

// ---------------------------------------------------------------- training

export function train(rows: Row[], now: Date, knownPatterns: Set<string> | null = null): Policy {
  prepare(rows);
  const nowMs = now.getTime();
  const ok = rows.filter(usable);
  const arms = new Map<string, Map<string, [number, number, number]>>();
  let totalK = 0.0;
  let totalT = 0.0;
  for (const r of ok) {
    const fp = cleanFingerprint(r.fingerprint);
    if (fp === null) continue;
    const w = weight(r, nowMs);
    const [k, t] = rewardParts(r);
    totalK += k * w;
    totalT += t * w;
    for (const ctx of contextKeys(fp)) {
      if (!arms.has(ctx)) arms.set(ctx, new Map());
      const per = arms.get(ctx)!;
      const tid = pyStr(r.template_id);
      if (!per.has(tid)) per.set(tid, [0.0, 0.0, 0]);
      const stat = per.get(tid)!;
      stat[0] += k * w;
      stat[1] += t * w;
      stat[2] += 1;
    }
  }
  const priorRate = totalT > 0 ? Math.min(2.0, Math.max(0.05, totalK / totalT)) : DEFAULT_PRIOR_RATE;
  const outArms = new Map<string, Map<string, Stat>>();
  for (const [c, per] of arms) {
    const m = new Map<string, Stat>();
    for (const [t, s] of per) m.set(t, [pyRound(s[0], 5), pyRound(s[1], 5), pyRound(s[2], 5)]);
    outArms.set(c, m);
  }
  return {
    version: 0,
    arms: outArms,
    templates: mineTemplates(ok, priorRate, knownPatterns ?? new Set()),
    priorRate: pyRound(priorRate, 5),
    priorStrength: DEFAULT_PRIOR_STRENGTH,
    training: { rows: ok.length, until: isoformat(now), country_stats: countryStats(ok, nowMs) },
    sites: mineSites(ok, nowMs),
  };
}

// ---------------------------------------------------------------- offline replay

function groups(rows: Row[]): Row[][] {
  const g = new Map<string, Row[]>();
  for (const r of rows) {
    if (!usable(r)) continue;
    const key = pyStr(r.created_at);
    if (!g.has(key)) g.set(key, []);
    g.get(key)!.push(r);
  }
  return [...g.values()].filter((x) => x.length >= 3);
}

export function liftAt2(policy: Policy, rows: Row[]): [number, number] {
  prepare(rows);
  const lifts: number[] = [];
  for (const g of groups(rows)) {
    const scored: Array<[number, number]> = [];
    for (const r of g) {
      const fp = cleanFingerprint(r.fingerprint);
      if (fp === null) continue;
      const [k, t] = rewardParts(r);
      const mean = posteriorMean(posterior(policy, contextKeys(fp), pyStr(r.template_id)));
      scored.push([mean, k / t]);
    }
    if (scored.length < 3) continue;
    const top = [...scored].sort((a, b) => b[0] - a[0]).slice(0, 2);
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    lifts.push(sum(top.map((x) => x[1])) / top.length - sum(scored.map((x) => x[1])) / scored.length);
  }
  return lifts.length ? [lifts.reduce((s, x) => s + x, 0) / lifts.length, lifts.length] : [0.0, 0];
}

// ---------------------------------------------------------------- the nightly decision

export type LearnResult = { policy: Policy | null; deploy: boolean; note: string; metrics: Record<string, unknown> };

/** Trust model: no holdout, no replay test, no minimum number of groups. Enough rows -> train on everything and deploy. */
export function learn(rows: Row[], active: Policy | null, now: Date, knownPatterns: Set<string> | null = null): LearnResult {
  void active;
  prepare(rows);
  const ok = rows.filter(usable);
  if (ok.length < MIN_ROWS_TO_LEARN) return { policy: null, deploy: false, note: "not_enough_data", metrics: { rows: ok.length } };
  const policy = train(ok, now, knownPatterns);
  const metrics: Record<string, unknown> = { rows: ok.length, templates: policy.templates.length, observations: observations(policy) };
  return { policy, deploy: true, note: "deployed", metrics };
}

export function decideRollback(rows: Row[], activeVersion: number, activatedAt: Date): [boolean, Record<string, unknown>] {
  prepare(rows);
  const ok = rows.filter(usable);
  const act = activatedAt.getTime();
  const recent = ok.filter((r) => r.strategy_version === activeVersion && r.kind !== "fixed" && parseTime(r.created_at) >= act);
  const baseFrom = act - BASELINE_DAYS * DAY_MS;
  const baseline = ok.filter((r) => {
    if (r.strategy_version === activeVersion || !(r.kind === "exploit" || r.kind === "experiment" || r.kind === "fixed")) return false;
    const t = parseTime(r.created_at);
    return baseFrom <= t && t < act;
  });
  const info: Record<string, unknown> = { recent_rows: recent.length, baseline_rows: baseline.length };
  if (recent.length < DRIFT_MIN_ROWS || baseline.length < DRIFT_MIN_ROWS) return [false, info];
  const rate = (rs: Row[]): number => {
    const k = rs.reduce((s, r) => s + rewardParts(r)[0], 0);
    const t = rs.reduce((s, r) => s + rewardParts(r)[1], 0);
    return t > 0 ? k / t : 0.0;
  };
  const recentRate = rate(recent);
  const baseRate = rate(baseline);
  info.recent_rate = pyRound(recentRate, 5);
  info.baseline_rate = pyRound(baseRate, 5);
  return [baseRate > 0 && recentRate < DRIFT_RATIO * baseRate, info];
}
