// Memory: Supabase. "Do we recognize the item?"
//
// Memory exists to save time and money on an item the Brain has already valued. It must never be the reason for a
// wrong answer, so it is built on one rule: when in doubt, it is a MISS and the Brain runs in full.
//
//   Getting IN (the write side, `storableReason`):
//     a valuation is kept for reuse only when the item was identified surely, the Judge independently agrees on brand
//     and model, real listings stand behind it (three or more), the range is narrow, the evidence is from the user's
//     own or a neighbouring market, nothing suggests a fake (the Authenticity eye saw no fake sign, repair, mismatched part
//     and no rare or limited piece), and nothing ran in a degraded way.
//
//   Getting OUT (the read side, in this order):
//     1. Identification must be sure and the item specific (brand AND a real model, never "unknown" or "classic").
//     2. The stored valuation must pass `checkStored`: same market, same rules version, confident, narrow, backed by
//        listings, not flagged, and not older than the limit for this KIND of item (prices age: a phone fast, an
//        antique slowly). The other valuations of the same item must agree with it (`selectStored`).
//     3. The Detail eye is never skipped. `memoryGate` compares what it sees now with what was stored:
//          same condition + brand or model readable on the item   -> HIT   (answer from Memory, no search, no Judge)
//          condition one grade away                                -> JUDGE (the Judge re-values the saved listings
//                                                                     against this photo, no new search)
//          anything else (far condition, fake signs, nothing readable that matches) -> MISS (full Brain)
//
// Memory is looked up with the item fingerprint made by Identification, never with the photo.

import type { BrainConfig } from "./config.ts";
import { MEMORY_MIN_BRAIN_VERSION } from "./config.ts";
import { languageOf } from "./markets.ts";
import { GRADES } from "./types.ts";
import type { AuthenticityReport, BrainResult, DetailReport, Finding, Fingerprint, Grade, Identification, JudgeVerdict } from "./types.ts";

function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function sortedTokens(s: string): string {
  return Array.from(new Set(s.split(/\s+/).filter(Boolean))).sort().join(" ");
}

/** Words of a text, lower-cased, accents and punctuation removed, split on spaces and hyphens. */
function wordsOf(s: string | null | undefined): string[] {
  return norm(s).split(/[\s-]+/).filter(Boolean);
}

/** Builds the item fingerprint. The country is the user's market (the places prices are looked up). */
export function buildFingerprint(ident: Identification, country: string | null, mode?: "resale" | "retail" | "auction"): Fingerprint {
  const c = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "ZZ";
  return {
    category: norm(ident.category) || "unknown",
    brand: norm(ident.brand) || null,
    type: norm(ident.type) || norm(ident.category) || "unknown",
    model: norm(ident.model) || null,
    era: norm(ident.era) || null,
    country: c,
    language: languageOf(c === "ZZ" ? null : c),
    ...(mode === "retail" || mode === "auction" ? { mode } : {}),
  };
}

// ---------------------------------------------------------------- is the item specific enough?

/** Words a model gives when it does not know. Two different items must never meet under such a "model". */
const GENERIC_WORDS = new Set([
  "unknown", "unknow", "n/a", "na", "none", "null", "nil", "standard", "classic", "original", "vintage", "generic",
  "various", "unbranded", "branded", "model", "type", "style", "series", "edition", "default", "regular", "normal",
  "other", "unspecified", "unmarked", "unidentified", "no", "name", "brand", "noname", "item", "product", "undefined",
]);

function isGeneric(value: string | null | undefined): boolean {
  const w = wordsOf(value);
  // "n/a" arrives as the two words "n" and "a", so the joined text is checked too.
  return w.length === 0 || GENERIC_WORDS.has(w.join("")) || w.every((t) => GENERIC_WORDS.has(t));
}

/** A real brand: not empty and not a placeholder such as "unbranded" or "no name". */
export function isSpecificBrand(brand: string | null | undefined): boolean {
  return norm(brand).length >= 2 && !isGeneric(brand);
}

/** A real model: at least two characters and not a placeholder such as "unknown", "classic" or "standard". */
export function isSpecificModel(model: string | null | undefined): boolean {
  return norm(model).replace(/[\s-]/g, "").length >= 2 && !isGeneric(model);
}

/**
 * The Memory key, or null when the item is not specific enough to be recognised safely.
 *
 * The stored valuation holds sentences in one language, so Swedish ones get their own key (`|sv`). English keys are
 * exactly what they were before, so nothing already stored is lost.
 */
export function memoryKey(fp: Fingerprint, lang?: "sv" | "en"): string | null {
  if (!fp.brand || !fp.model) return null;
  if (!isSpecificBrand(fp.brand) || !isSpecificModel(fp.model)) return null;
  return `m1|${sortedTokens(fp.brand)}|${sortedTokens(fp.model)}|${fp.country}${lang === "sv" ? "|sv" : ""}`;
}

/** Whether Identification is sure enough to even look in Memory. */
export function canLookInMemory(ident: Identification, cfg: BrainConfig): boolean {
  return ident.identifiable && ident.confidence >= cfg.memoryMinIdentConfidence;
}

// ---------------------------------------------------------------- prices age: how long may a valuation live?

export type AgeClass = "fast" | "normal" | "slow";

/** Goods whose market prices move within weeks: electronics, new models arrive, old ones drop. */
const FAST_GOODS =
  /\b(phones?|smartphones?|iphones?|mobiles?|tablets?|ipads?|laptops?|notebooks?|computers?|pcs?|desktops?|monitors?|tvs?|televisions?|consoles?|playstations?|xbox|nintendo|gpus?|graphics cards?|processors?|cpus?|smartwatch(es)?|headphones?|earbuds?|earphones?|airpods|drones?|electronics?|gadgets?|gaming)\b/i;

/** Goods whose prices change slowly: things valued for age and rarity rather than for being the latest model. */
const SLOW_GOODS =
  /\b(antiques?|art|artworks?|paintings?|sculptures?|collectibles?|collectables?|coins?|stamps?|banknotes?|medals?|books?|porcelain|ceramics?|pottery|figurines?|militaria|memorabilia|trading cards?|posters?|rugs?|carpets?|silverware)\b/i;

/** The speed at which prices of this kind of item age. Unknown or unclear: normal. Fast wins over slow. */
export function ageClassOf(category: string | null | undefined): AgeClass {
  const c = (category ?? "").toLowerCase();
  if (FAST_GOODS.test(c)) return "fast";
  if (SLOW_GOODS.test(c)) return "slow";
  return "normal";
}

/**
 * How many days a valuation of these categories may be reused. When two categories are given (the stored one and
 * the one seen now) and they disagree, the SHORTER limit wins: a stored "book" valuation must not live 90 days
 * because today's photo is of the same thing seen as "tablet".
 */
export function maxAgeDaysFor(cfg: BrainConfig, ...categories: (string | null | undefined)[]): number {
  const days = (c: AgeClass) => (c === "fast" ? cfg.memoryFastAgeDays : c === "slow" ? cfg.memorySlowAgeDays : cfg.memoryMaxAgeDays);
  const list = categories.length > 0 ? categories : [null];
  return Math.min(...list.map((c) => days(ageClassOf(c))));
}

/** The most confidence points an old valuation loses (reached at the age limit). */
export const MEMORY_AGE_DECAY_MAX = 15;

/** Older means less sure: 0 points when brand new, MEMORY_AGE_DECAY_MAX at the age limit. */
export function ageDecay(ageDays: number, maxAgeDays: number): number {
  if (!(maxAgeDays > 0)) return MEMORY_AGE_DECAY_MAX;
  return Math.round(MEMORY_AGE_DECAY_MAX * Math.min(1, Math.max(0, ageDays / maxAgeDays)));
}

// ---------------------------------------------------------------- reading a stored valuation

export interface StoredValuation {
  runId: string;
  result: BrainResult;
  createdAt: string; // ISO
  memoryEligible: boolean;
  /** The Brain version that made it (l_runs.brain_version). Missing means unknown, and unknown is not trusted. */
  brainVersion?: string | null;
}

/** Other valuations of the same item may differ this much (as a ratio of the middle value) before Memory distrusts all of them. */
export const MEMORY_PEER_MAX_RATIO = 1.6;

export type StoredCheck = { ok: true; ageDays: number; maxAgeDays: number } | { ok: false; reason: string };

/** True when `version` ("brain-4.1.0") is at least the first version whose Memory rules are trusted. */
export function isTrustedBrainVersion(version: string | null | undefined): boolean {
  const m = /^brain-(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (have[i] !== MEMORY_MIN_BRAIN_VERSION[i]) return have[i] > MEMORY_MIN_BRAIN_VERSION[i];
  }
  return true;
}

/** The evidence a valuation may rest on and still be reused: the user's own market or a neighbouring one. */
function basisIsUsable(basis: string | undefined): boolean {
  return basis === "local" || basis === "regional";
}

function spreadOf(r: Pick<BrainResult, "low" | "high">): number {
  return r.low > 0 ? r.high / r.low : Infinity;
}

/**
 * Decides whether ONE stored valuation may answer for a recognised item. Pure, so it can be tested.
 *
 * `country` is the market of the person asking. The Memory key already contains the country, and this is a second
 * lock: a valuation that does not say it belongs to this market is never used (an old one that says nothing is
 * not trusted either), so a Swedish price can never be shown to a German user as if it were theirs.
 *
 * `categoryNow` is the category Identification gave for the photo in hand; together with the stored category it
 * decides how old the valuation may be.
 */
export function checkStored(
  stored: StoredValuation,
  cfg: BrainConfig,
  nowMs: number,
  country: string,
  categoryNow?: string | null,
): StoredCheck {
  const r = stored.result;
  if (!stored.memoryEligible) return { ok: false, reason: "not_eligible" };
  if (!isTrustedBrainVersion(stored.brainVersion)) return { ok: false, reason: "old_version" };
  if (r.status !== "ok" || !(r.mid > 0)) return { ok: false, reason: "not_a_valuation" };
  if (!r.market) return { ok: false, reason: "no_market" };
  if (r.market.country !== country) return { ok: false, reason: "other_market" };
  if (!basisIsUsable(r.market.basis)) return { ok: false, reason: "weak_evidence" };
  if (r.authenticityFlag !== "none") return { ok: false, reason: "authenticity" };
  if (!(r.confidenceScore >= cfg.memoryMinConfidence)) return { ok: false, reason: "low_confidence" };
  if (!(spreadOf(r) <= cfg.memoryMaxSpread)) return { ok: false, reason: "too_wide" };
  if ((r.comparables ?? []).filter((c) => c.price > 0).length < cfg.memoryMinComps) return { ok: false, reason: "few_listings" };

  const created = Date.parse(stored.createdAt);
  if (!Number.isFinite(created)) return { ok: false, reason: "bad_date" };
  const ageMs = nowMs - created;
  if (ageMs < -5 * 60 * 1000) return { ok: false, reason: "bad_date" }; // from the future: a clock or a data fault
  const maxAgeDays = maxAgeDaysFor(cfg, r.category, categoryNow);
  const ageDays = Math.max(0, ageMs) / 86_400_000;
  if (ageDays > maxAgeDays) return { ok: false, reason: "too_old" };
  return { ok: true, ageDays, maxAgeDays };
}

/** Boolean form of `checkStored`. */
export function isUsableHit(stored: StoredValuation, cfg: BrainConfig, nowMs: number, country: string, categoryNow?: string | null): boolean {
  return checkStored(stored, cfg, nowMs, country, categoryNow).ok;
}

function gradeIndex(g: Grade | undefined): number {
  const i = GRADES.indexOf(g as Grade);
  return i < 0 ? 99 : i;
}

/** How many steps apart two condition grades are (new, like-new, good, fair, poor). */
export function gradeDistance(a: Grade, b: Grade): number {
  return Math.abs(gradeIndex(a) - gradeIndex(b));
}

export interface Selection {
  stored: StoredValuation | null;
  check: StoredCheck | null;
  /** "ok" when a valuation was chosen, otherwise why none was ("no_valuations", "too_old", "peers_disagree", ...). */
  reason: string;
  /** How many saved valuations of this item were looked at. */
  candidates: number;
}

/**
 * Picks the one saved valuation that may answer, out of the newest few for this item.
 *
 *  - Only valuations that pass `checkStored` count.
 *  - The best is the one whose condition is closest to the condition seen now (then the newest).
 *  - Several valuations of the same item and condition must agree. If they differ by more than
 *    MEMORY_PEER_MAX_RATIO, nobody can tell which one is right, so none is used.
 */
export function selectStored(
  rows: StoredValuation[],
  grade: Grade | null,
  cfg: BrainConfig,
  nowMs: number,
  country: string,
  categoryNow?: string | null,
): Selection {
  if (rows.length === 0) return { stored: null, check: null, reason: "no_valuations", candidates: 0 };
  const checked = rows.map((row) => ({ row, check: checkStored(row, cfg, nowMs, country, categoryNow) }));
  const valid = checked.filter((c): c is { row: StoredValuation; check: Extract<StoredCheck, { ok: true }> } => c.check.ok);
  if (valid.length === 0) {
    const first = checked[0].check;
    return { stored: null, check: first, reason: first.ok ? "unknown" : first.reason, candidates: rows.length };
  }
  const dist = (v: StoredValuation) => (grade ? gradeDistance(v.result.condition, grade) : 0);
  valid.sort((a, b) => dist(a.row) - dist(b.row) || Date.parse(b.row.createdAt) - Date.parse(a.row.createdAt));
  const best = valid[0];
  for (const other of valid.slice(1)) {
    if (other.row.result.condition !== best.row.result.condition) continue; // a different condition is allowed to cost differently
    const ratio = Math.max(best.row.result.mid, other.row.result.mid) / Math.min(best.row.result.mid, other.row.result.mid);
    if (ratio > MEMORY_PEER_MAX_RATIO) {
      return { stored: null, check: best.check, reason: "peers_disagree", candidates: rows.length };
    }
  }
  return { stored: best.row, check: best.check, reason: "ok", candidates: rows.length };
}

// ---------------------------------------------------------------- the Detail eye is never skipped

const FAKE_SIGNS =
  /\b(fake|fakes|replica|replicas|counterfeit|knock-?offs?|forged|forgery|suspicious|suspect|inconsistent|misspell\w*|misspelt|wrong|incorrect|mismatch\w*|not genuine|unauthori[sz]ed|reproduction|poor quality|cheap|irregular|off-?cent(?:er|re)d?|crooked|uneven)\b/i;

/** True when the Detail eye reports something that points to a fake or an altered item. */
export function detailRaisesAuthenticity(detail: DetailReport): boolean {
  if (detail.authenticity_signals.some((s) => FAKE_SIGNS.test(s))) return true;
  // The places a fake gives itself away: the marks, labels and numbers.
  return detail.details.some((d) => ["logo", "stamp", "label", "serial"].includes(d.kind) && FAKE_SIGNS.test(d.text));
}

/**
 * Can the Detail eye read the brand (or the model) on the item itself? Identification works out what the item is
 * from the whole picture. The Detail eye reads the marks. When what Identification says appears in the marks, two
 * separate looks agree, and that is what turns a guess into a recognition.
 *
 * Exact words only: "SNK809K1" on the item does not confirm the model "SNK809" (it is another variant).
 */
export function corroborates(fp: Fingerprint, detail: DetailReport): boolean {
  const seen = new Set(detail.details.flatMap((d) => wordsOf(d.text)));
  const allSeen = (value: string | null) => {
    const w = wordsOf(value);
    return w.length > 0 && w.every((t) => seen.has(t));
  };
  if (isSpecificBrand(fp.brand) && allSeen(fp.brand)) return true;
  // A short model ("5", "S3") appears in too many texts to prove anything on its own.
  return norm(fp.model).replace(/[\s-]/g, "").length >= 4 && isSpecificModel(fp.model) && allSeen(fp.model);
}

export type GateOutcome =
  | { outcome: "hit"; reason: "same_item_same_condition" }
  | { outcome: "judge"; reason: "condition_differs" }
  | { outcome: "miss"; reason: string };

/**
 * Compares the item in the photo (seen by the Detail eye) with the stored valuation. Pure.
 *
 *   HIT    the same item in the same condition: answer from Memory.
 *   JUDGE  the same item, condition one grade away: the Judge re-values the saved listings against this photo.
 *   MISS   anything else: the Brain runs in full.
 */
export function memoryGate(stored: StoredValuation, fp: Fingerprint, detail: DetailReport | null, cfg: BrainConfig): GateOutcome {
  if (!detail) return { outcome: "miss", reason: "no_detail" };
  if (detailRaisesAuthenticity(detail)) return { outcome: "miss", reason: "fake_signs" };
  if (cfg.memoryRequireCorroboration && !corroborates(fp, detail)) return { outcome: "miss", reason: "not_corroborated" };
  const d = gradeDistance(stored.result.condition, detail.condition.grade);
  if (d === 0) return { outcome: "hit", reason: "same_item_same_condition" };
  if (d === 1 && (stored.result.comparables ?? []).filter((c) => c.price > 0).length >= 2) {
    return { outcome: "judge", reason: "condition_differs" };
  }
  return { outcome: "miss", reason: d === 1 ? "no_listings_to_reuse" : "condition_far" };
}

// ---------------------------------------------------------------- getting IN: what may be stored for reuse

function sameWords(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = sortedTokens(norm(a));
  return x !== "" && x === sortedTokens(norm(b));
}

/** The Judge looked at the photo on its own. Does it name the same brand and model that Identification did? */
export function judgeAgreesWithIdent(ident: Identification, verdict: JudgeVerdict): boolean {
  return sameWords(ident.brand, verdict.brand) && sameWords(ident.model, verdict.model);
}

export interface StorableArgs {
  cfg: BrainConfig;
  key: string | null;
  judgeRan: boolean;
  result: BrainResult;
  ident: Identification | null;
  verdict: JudgeVerdict | null;
  /** Listings the Judge kept as "the very same item". */
  keptCount: number;
  degraded: string[];
  /** Authenticity eye. Optional: a missing eye is already kept out through the degraded flags (authenticity_eye_failed / _late). */
  authenticity?: AuthenticityReport | null;
}

/** Runs that went wrong in some way, or that rest on a stand-in. Their price is an answer for today, never a fact to reuse. */
const NEVER_STORE_IF = [
  "judge_partial", "judge_emergency", "authenticity_eye_failed", "authenticity_eye_late", "judge_failed", "judge_no_time",
  "detail_eye_failed", "detail_eye_late", "identification_failed",
  "no_market_estimate", "fx_fallback", "memory_judged", "memory_condition_unverified",
];

/**
 * Why a new valuation must NOT be kept for reuse, or null when it may. Pure. This is the door into Memory: a wrong
 * valuation that gets in here is shown to many people, so every doubt keeps it out.
 */
export function storableReason(a: StorableArgs): string | null {
  const { cfg, result: r } = a;
  if (!a.key) return "no_key";
  if (!a.judgeRan || !a.verdict) return "no_judge";
  for (const flag of NEVER_STORE_IF) if (a.degraded.includes(flag)) return flag;
  if (r.status !== "ok") return "not_a_valuation";
  if (!a.ident || !(a.ident.confidence >= cfg.memoryMinIdentConfidence)) return "identification_unsure";
  if (!judgeAgreesWithIdent(a.ident, a.verdict)) return "judge_disagrees";
  if (r.authenticityFlag !== "none") return "authenticity";
  // Authenticity eye (the unique eye) saw a concrete sign that this very specimen is not the typical item of its model: a fake sign, a
  // repaired or replaced part, a part that does not fit, or a rare / limited piece. Its price is an answer for today, not a fact to reuse.
  const au = a.authenticity;
  if (au && au.signs.some((x) => x.kind === "fake_sign" || x.kind === "repair" || x.kind === "inconsistency")) return "authenticity_signs";
  if (au && (au.rarity_hint === "rare" || au.rarity_hint === "very_rare")) return "rare_item";
  if (r.needsMoreInfo) return "needs_more_info";
  if (!r.market || !basisIsUsable(r.market.basis)) return "weak_evidence";
  if (a.keptCount < cfg.memoryMinComps) return "few_listings";
  if (!(r.confidenceScore >= cfg.memoryMinConfidence)) return "low_confidence";
  if (!(spreadOf(r) <= cfg.memoryMaxSpread)) return "too_wide";
  return null;
}

// ---------------------------------------------------------------- reusing the saved listings (JUDGE outcome)

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * The listings behind a stored valuation, as findings the Judge can read again. They are the ones the Judge kept as
 * "the very same item" when the valuation was made. Their prices are NOT refreshed.
 */
export function storedAsFindings(stored: StoredValuation): Finding[] {
  const country = stored.result.market?.country ?? "ZZ";
  const list = (stored.result.comparables ?? [])
    .filter((c) => c.price > 0)
    .slice(0, 5)
    .map((c) => ({
      searchId: "memory",
      title: c.title,
      snippet: "",
      url: c.url,
      site: hostOf(c.url),
      kind: c.kind === "sold" ? ("sold" as const) : ("asking" as const),
      price: c.price,
      currency: "USD",
      priceUsd: c.price,
      gl: c.origin ?? country,
      origin: c.origin ?? country,
      tier: c.tier ?? ("local" as const),
    }));
  list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "sold" ? -1 : 1));
  return list.map((f, i) => ({ id: i + 1, ...f }));
}
