// Every answer from a model, and from the Search AI, is checked here before the next step may
// use it. An invalid answer fails its step instead of passing nonsense down the pipe.

import { AUTH_SIGN_KINDS, DETAIL_KINDS, GRADES, RISKS } from "./types.ts";
import type {
  AdCondition,
  AdLabel,
  AdMatch,
  AuthenticityReport,
  AuthSignKind,
  DetailNote,
  DetailReport,
  Grade,
  Identification,
  JudgeVerdict,
  PlannedSearch,
  PriceRange,
  Risk,
  SearchKind,
  SearchPlan,
} from "./types.ts";
import { HARD_CAPS } from "./config.ts";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Largest price we accept. Anything above is treated as an error. */
export const MAX_PRICE = 50_000_000;
/** The smallest price (USD) the Judge may give. Cheap things are worth cents, not nothing. */
export const MIN_JUDGE_PRICE = 0.01;

type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Removes control characters and collapses whitespace. Model text is data, keep it tidy. */
export function clean(s: string, max: number): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function reqStr(o: Rec, key: string, errors: string[], max: number, min = 1): string {
  const v = o[key];
  if (typeof v !== "string") {
    errors.push(`"${key}" must be a string`);
    return "";
  }
  const c = clean(v, max);
  if (c.length < min) errors.push(`"${key}" must not be empty`);
  return c;
}

function optStr(o: Rec, key: string, max: number): string {
  const v = o[key];
  return typeof v === "string" ? clean(v, max) : "";
}

function nullableStr(o: Rec, key: string, max: number): string | null {
  const v = o[key];
  if (typeof v !== "string") return null;
  const c = clean(v, max);
  if (c === "" || /^(null|none|unknown|n\/a|na|-)$/i.test(c)) return null;
  return c;
}

export function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

function reqNum(o: Rec, key: string, errors: string[], min: number, max: number): number {
  const n = toNumber(o[key]);
  if (n === null) {
    errors.push(`"${key}" must be a number`);
    return 0;
  }
  if (n < min || n > max) {
    errors.push(`"${key}" must be between ${min} and ${max}`);
    return 0;
  }
  return n;
}

function normEnum(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function readEnum<T extends string>(raw: unknown, allowed: readonly T[], errors: string[], label: string, fallback?: T): T {
  if (typeof raw === "string") {
    const n = normEnum(raw);
    for (const a of allowed) if (normEnum(a) === n) return a;
  }
  if (fallback !== undefined && (raw === undefined || raw === null || raw === "")) return fallback;
  errors.push(`"${label}" must be one of: ${allowed.join(", ")}`);
  return fallback ?? allowed[0];
}

function stringList(o: Rec, key: string, maxItems: number, maxLen: number): string[] {
  const v = o[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const c = clean(item, maxLen);
    if (c) out.push(c);
    if (out.length >= maxItems) break;
  }
  return out;
}

function readGrade(o: Rec, errors: string[]): { grade: Grade; details: string } {
  const cond = o["condition"];
  if (!isRec(cond)) {
    errors.push(`"condition" must be an object with grade and details`);
    return { grade: "good", details: "" };
  }
  return { grade: readEnum(cond["grade"], GRADES, errors, "condition.grade"), details: optStr(cond, "details", 200) };
}

// ---------------------------------------------------------------- Detail eye

export function validateDetailReport(raw: unknown): Validation<DetailReport> {
  if (!isRec(raw)) return { ok: false, errors: ["answer must be one JSON object"] };
  const errors: string[] = [];
  const details: DetailNote[] = [];
  const list = raw["details"];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!isRec(item) || typeof item["text"] !== "string") continue;
      const text = clean(item["text"], 160);
      if (!text) continue;
      const kindRaw = typeof item["kind"] === "string" ? normEnum(item["kind"]) : "other";
      const kind = (DETAIL_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as DetailNote["kind"]) : "other";
      details.push({ kind, text });
      if (details.length >= 8) break;
    }
  }
  const condition = readGrade(raw, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { details, condition, authenticity_signals: stringList(raw, "authenticity_signals", 4, 160) } };
}

// ---------------------------------------------------------------- Identification

export function validateIdentification(raw: unknown): Validation<Identification> {
  if (!isRec(raw)) return { ok: false, errors: ["answer must be one JSON object"] };
  const errors: string[] = [];
  const identifiable = raw["identifiable"];
  if (typeof identifiable !== "boolean") errors.push(`"identifiable" must be true or false`);
  const ok = identifiable === true;

  const what_is_it = reqStr(raw, "what_is_it", errors, 300, ok ? 1 : 0);
  const display_name = reqStr(raw, "display_name", errors, 60, ok ? 1 : 0);
  const category = reqStr(raw, "category", errors, 40, ok ? 1 : 0);
  const type = reqStr(raw, "type", errors, 80, ok ? 1 : 0);
  const confidence = Math.round(reqNum(raw, "confidence", errors, 0, 100));

  const google_queries = stringList(raw, "google_queries", 5, 120).filter((q) => q.length >= 3);
  if (ok && google_queries.length === 0) errors.push(`"google_queries" needs at least one query`);

  if (errors.length > 0) return { ok: false, errors };
  const origin = nullableStr(raw, "origin_country", 2);
  return {
    ok: true,
    value: {
      identifiable: ok,
      what_is_it,
      display_name,
      category,
      type,
      brand: nullableStr(raw, "brand", 80),
      model: nullableStr(raw, "model", 100),
      era: nullableStr(raw, "era", 40),
      origin_country: origin && /^[A-Za-z]{2}$/.test(origin) ? origin.toUpperCase() : null,
      confidence,
      google_queries,
      ...anchorFacts(raw),
    },
  };
}

/** Estimate-mode facts: every field validated, unreadable or out of range = null, never guessed. */
function anchorFacts(raw: Rec): Pick<Identification, "new_price_usd" | "new_price_basis" | "material" | "rarity" | "age_class"> {
  const p = toNumber(raw["new_price_usd"]);
  const basis = raw["new_price_basis"];
  const basisOk = basis === "known_model" || basis === "brand_category_typical" || basis === "comparable_objects";
  const priceOk = p !== null && Number.isFinite(p) && p > 0 && p <= MAX_PRICE;
  const r = raw["rarity"];
  const a = raw["age_class"];
  return {
    new_price_usd: priceOk && basisOk ? Math.round(p * 100) / 100 : null,
    new_price_basis: priceOk && basisOk ? (basis as "known_model" | "brand_category_typical" | "comparable_objects") : "none",
    material: nullableStr(raw, "material", 40),
    rarity: r === "common" || r === "unknown" || r === "rare" || r === "very_rare" ? r : null,
    age_class: typeof a === "string" && ["new", "recent", "mid", "old", "vintage", "antique", "unknown"].includes(a) ? a : null,
  };
}

// ---------------------------------------------------------------- Judge

function idList(o: Rec, key: string, count: number): number[] {
  const v = o[key];
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    const n = toNumber(item);
    if (n !== null && Number.isInteger(n) && n >= 1 && n <= count && !out.includes(n)) out.push(n);
  }
  return out;
}

function readPrice(o: Rec, errors: string[], mustBePositive: boolean): PriceRange {
  const p = o["price"];
  if (!isRec(p)) {
    errors.push(`"price" must be an object with low, mid and high`);
    return { low: 0, mid: 0, high: 0 };
  }
  const sub: string[] = [];
  const nums = [reqNum(p, "low", sub, 0, MAX_PRICE), reqNum(p, "mid", sub, 0, MAX_PRICE), reqNum(p, "high", sub, 0, MAX_PRICE)];
  for (const e of sub) errors.push(`price.${e}`);
  if (sub.length > 0) return { low: 0, mid: 0, high: 0 };
  // Three numbers in the wrong order are a slip, not a different opinion. Put them in order.
  nums.sort((a, b) => a - b);
  if (mustBePositive && !(nums[0] > 0)) {
    // A nearly worthless item: the Judge wrote 0. The interval maths takes logarithms, so a real zero would break it.
    // Use the smallest real price instead of throwing the whole answer away.
    for (let i = 0; i < nums.length; i++) if (!(nums[i] > 0)) nums[i] = MIN_JUDGE_PRICE;
  }
  return { low: nums[0], mid: nums[1], high: nums[2] };
}

/**
 * `findingCount` is how many findings the Judge was shown. Ids outside 1..count are ignored.
 *
 * `partial`: the time ran out and the answer was cut off. Only the essentials are required
 * (is it identifiable, and the price range). Anything the Judge did not finish is reported in
 * `missing` and the caller fills it from the Eyes, so nothing is ever made up.
 */
export function validateJudge(raw: unknown, findingCount: number, partial = false): Validation<JudgeVerdict> {
  if (!isRec(raw)) return { ok: false, errors: ["answer must be one JSON object"] };
  const missing: string[] = [];
  let src: Rec = raw;
  if (partial) {
    const patched: Rec = { ...raw };
    const fill = (key: string, value: unknown) => {
      if (patched[key] === undefined) {
        patched[key] = value;
        missing.push(key);
      }
    };
    if (patched["identifiable"] === true) {
      fill("display_name", "unknown item");
      fill("category", "unknown");
      fill("condition", { grade: "good", details: "" });
      fill("confidence", 40);
      fill("authenticity_risk", "unknown");
    }
    src = patched;
  }
  const errors: string[] = [];
  const identifiable = src["identifiable"];
  if (typeof identifiable !== "boolean") errors.push(`"identifiable" must be true or false`);
  const ok = identifiable === true;

  const display_name = reqStr(src, "display_name", errors, 60, ok ? 1 : 0);
  const category = reqStr(src, "category", errors, 40, ok ? 1 : 0);
  const condition = readGrade(src, errors);
  const price = readPrice(src, errors, ok);
  const confidence = Math.round(reqNum(src, "confidence", errors, 0, 100));
  const authenticity_risk = readEnum(src["authenticity_risk"], RISKS, errors, "authenticity_risk", "unknown");

  const same = idList(src, "same", findingCount);
  const similar = idList(src, "similar", findingCount).filter((n) => !same.includes(n));

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      missing,
      identifiable: ok,
      display_name,
      category,
      brand: nullableStr(src, "brand", 80),
      model: nullableStr(src, "model", 100),
      condition,
      same,
      similar,
      price,
      confidence,
      authenticity_risk,
      authenticity_note: optStr(src, "authenticity_note", 200),
      unknowns: stringList(src, "unknowns", 3, 140),
      extra_photo_request: nullableStr(src, "extra_photo_request", 200),
      reason: optStr(src, "reason", 300),
    },
  };
}

// ---------------------------------------------------------------- Search AI plan

const SEARCH_KINDS: readonly SearchKind[] = ["exploit", "experiment", "fixed"];

/**
 * The Search AI answers in strict JSON. This is the "validated by code" gate: one bad field
 * rejects the whole plan and the fixed templates take over. The Search AI can only choose
 * WHICH searches to run. It never outputs prices.
 */
export function validateSearchPlan(raw: unknown): Validation<SearchPlan> {
  if (!isRec(raw)) return { ok: false, errors: ["plan must be one JSON object"] };
  const errors: string[] = [];
  if (raw["ok"] !== true) errors.push(`"ok" must be true`);

  const version = toNumber(raw["strategy_version"]);
  if (version === null || !Number.isInteger(version) || version < 1) errors.push(`"strategy_version" must be a whole number >= 1`);

  const list = raw["searches"];
  const searches: PlannedSearch[] = [];
  if (!Array.isArray(list) || list.length < 1 || list.length > HARD_CAPS.searches) {
    errors.push(`"searches" must hold 1 to ${HARD_CAPS.searches} searches`);
  } else {
    const ids = new Set<string>();
    let experiments = 0;
    list.forEach((item, i) => {
      if (!isRec(item)) {
        errors.push(`searches[${i}] must be an object`);
        return;
      }
      const id = typeof item["id"] === "string" ? item["id"] : "";
      if (!/^s[1-4]$/.test(id) || ids.has(id)) errors.push(`searches[${i}].id must be a unique s1..s4`);
      ids.add(id);

      const queryRaw = typeof item["query"] === "string" ? item["query"] : "";
      const query = clean(queryRaw, 140);
      if (query.length < 3 || query.length > 120 || query !== queryRaw.trim().replace(/\s+/g, " ")) {
        errors.push(`searches[${i}].query must be 3-120 plain characters`);
      }

      const template_id = typeof item["template_id"] === "string" ? item["template_id"] : "";
      if (!/^[A-Za-z0-9:_.|{}-]{1,80}$/.test(template_id)) errors.push(`searches[${i}].template_id is not valid`);

      const kind = typeof item["kind"] === "string" ? (item["kind"] as SearchKind) : "fixed";
      if (!SEARCH_KINDS.includes(kind)) errors.push(`searches[${i}].kind is not valid`);
      if (kind === "experiment") experiments++;

      const gl = typeof item["gl"] === "string" ? item["gl"].toLowerCase() : "";
      const hl = typeof item["hl"] === "string" ? item["hl"].toLowerCase() : "";
      if (!/^[a-z]{2}$/.test(gl)) errors.push(`searches[${i}].gl must be a two-letter country`);
      if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(hl)) errors.push(`searches[${i}].hl must be a language code`);
      // Optional: the Search AI says which tier of the country ladder this search belongs to. Market
      // Live works the tier out from `gl` itself, so this is information (and goes to the log).
      const tierRaw = item["tier"];
      let tier: PlannedSearch["tier"];
      if (tierRaw !== undefined && tierRaw !== null) {
        if (tierRaw === "local" || tierRaw === "regional" || tierRaw === "global") tier = tierRaw;
        else errors.push(`searches[${i}].tier must be local, regional or global`);
      }
      searches.push(tier ? { id, query, template_id, kind, gl, hl, tier } : { id, query, template_id, kind, gl, hl });
    });
    if (experiments > HARD_CAPS.experimentSlots) errors.push(`at most ${HARD_CAPS.experimentSlots} experiment searches are allowed`);
  }

  const stopRaw = raw["stop"];
  let soldPrices: number = HARD_CAPS.soldPrices;
  let maxMs: number = HARD_CAPS.searchMs;
  if (isRec(stopRaw)) {
    const s = toNumber(stopRaw["sold_prices"]);
    const m = toNumber(stopRaw["max_ms"]);
    if (s === null || !Number.isInteger(s) || s < 1 || s > HARD_CAPS.soldPrices) errors.push(`"stop.sold_prices" must be 1 to ${HARD_CAPS.soldPrices}`);
    else soldPrices = s;
    if (m === null || !Number.isInteger(m) || m < 300 || m > HARD_CAPS.searchMs) errors.push(`"stop.max_ms" must be 300 to ${HARD_CAPS.searchMs}`);
    else maxMs = m;
  } else {
    errors.push(`"stop" must be an object`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { strategyVersion: version as number, source: "search_ai", searches, stop: { soldPrices, maxMs } },
  };
}

/** Same URL, different dress: drop fragment, trailing slash and a leading "www.". */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    url.hash = "";
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${host}${path}${url.search}`;
  } catch {
    return u.trim();
  }
}


import { consistentPSame, readIdentityCertainty, readPSame, readRelative, readReliability, readVariantDiffs } from "./judge-schema.ts";
import { oldConditionOf } from "./ad-calibration.ts";
// ---------------------------------------------------------------- Judge (labels only) and Authenticity eye

const AD_MATCHES = ["same", "similar", "different"] as const;
const AD_CONDITIONS = ["worse", "equal", "better"] as const;

/**
 * The Judge (Haiku 5.5) answers with LABELS only: per ad "same / similar / different" and "worse / equal / better", the
 * authenticity risk, the condition and the check of the eyes' text against the photo. It never writes a price or a
 * confidence; if it does, they are ignored. The placeholders below are replaced by code (math.ts) before anything is shown.
 * `partial` accepts a cut-off answer when the item identity and the labels so far are readable.
 */
export function validateJudgeLabels(raw: unknown, findingCount: number, partial = false): Validation<JudgeVerdict> {
  if (!isRec(raw)) return { ok: false, errors: ["answer must be one JSON object"] };
  const missing: string[] = [];
  const src: Rec = { ...raw };
  const fill = (key: string, value: unknown) => {
    if (src[key] === undefined) {
      src[key] = value;
      if (partial) missing.push(key);
    }
  };
  if (src["identifiable"] === true) {
    fill("display_name", "unknown item");
    fill("category", "unknown");
    fill("condition", { grade: "good", details: "" });
    fill("authenticity_risk", "unknown");
  }
  const errors: string[] = [];
  const identifiable = src["identifiable"];
  if (typeof identifiable !== "boolean") errors.push(`"identifiable" must be true or false`);
  const ok = identifiable === true;
  const display_name = reqStr(src, "display_name", errors, 60, ok ? 1 : 0);
  const category = reqStr(src, "category", errors, 40, ok ? 1 : 0);
  const condition = readGrade(src, errors);
  const authenticity_risk = readEnum(src["authenticity_risk"], RISKS, errors, "authenticity_risk", "unknown");

  const ads: AdLabel[] = [];
  const seen = new Set<number>();
  if (Array.isArray(src["ads"])) {
    for (const item of src["ads"]) {
      if (!isRec(item)) continue;
      const id = toNumber(item["id"]);
      if (id === null || !Number.isInteger(id) || id < 1 || id > findingCount || seen.has(id)) continue;
      const m = typeof item["match"] === "string" ? normEnum(item["match"]) : "";
      if (!(AD_MATCHES as readonly string[]).includes(m)) continue; // an unreadable label is dropped, never guessed
      const rv = readRelative(item["relative_value"]);
      const c = rv ? oldConditionOf(rv) : typeof item["condition_vs_ad"] === "string" ? normEnum(item["condition_vs_ad"]) : "equal";
      seen.add(id);
      const ps = consistentPSame(m as AdMatch, readPSame(item["p_same"]));
      const rel = readReliability(item["ad_reliability"]);
      const vd = readVariantDiffs(item["variant_diffs"]);
      ads.push({
        id, match: m as AdMatch, condition_vs_ad: (AD_CONDITIONS as readonly string[]).includes(c) ? (c as AdCondition) : "equal",
        ...(rv ? { relative_value: rv } : {}),
        ...(ps ? { p_same: ps } : {}), ...(rel ? { ad_reliability: rel } : {}), ...(vd.length ? { variant_diffs: vd } : {}),
      });
    }
  } else if (ok && !partial) errors.push(`"ads" must be a list`);
  if (ok && !partial && findingCount > 0 && ads.length === 0) errors.push(`"ads" must label the findings`);

  if (errors.length > 0) return { ok: false, errors };
  const same = ads.filter((a) => a.match === "same").map((a) => a.id);
  const similar = ads.filter((a) => a.match === "similar").map((a) => a.id);
  return {
    ok: true,
    value: {
      missing,
      identifiable: ok,
      display_name,
      category,
      brand: nullableStr(src, "brand", 80),
      model: nullableStr(src, "model", 100),
      condition,
      same,
      similar,
      ads,
      eye_text_mismatch: stringList(src, "eye_text_mismatch", 4, 140),
      ...(readIdentityCertainty(src["identity_certainty"]) ? { identity_certainty: readIdentityCertainty(src["identity_certainty"]) } : {}),
      // Placeholders: math.ts overwrites both. The Judge may not set a final price or a confidence.
      price: { low: 0.01, mid: 0.01, high: 0.01 },
      confidence: 0,
      authenticity_risk,
      authenticity_note: optStr(src, "authenticity_note", 200),
      unknowns: stringList(src, "unknowns", 3, 140),
      extra_photo_request: nullableStr(src, "extra_photo_request", 200),
      reason: optStr(src, "reason", 300),
    },
  };
}

export function validateAuthenticityReport(raw: unknown): Validation<AuthenticityReport> {
  if (!isRec(raw)) return { ok: false, errors: ["answer must be one JSON object"] };
  // The Authenticity eye is the unique eye: construction, era, repairs, rarity, originality, inconsistencies, material cues.
  // Old-schema fields (marks, maker, purity_or_grade) are NOT read: reading stamps and naming the maker belongs to the other eyes.
  const signs: AuthenticityReport["signs"] = [];
  if (Array.isArray(raw["signs"])) {
    for (const item of raw["signs"]) {
      if (!isRec(item) || typeof item["text"] !== "string") continue;
      const text = clean(item["text"], 160);
      if (!text) continue;
      const k = typeof item["kind"] === "string" ? normEnum(item["kind"]) : "other";
      signs.push({ kind: (AUTH_SIGN_KINDS as readonly string[]).includes(k) ? (k as AuthSignKind) : "other", text });
      if (signs.length >= 5) break;
    }
  }
  const eraRaw = typeof raw["era"] === "string" ? clean(raw["era"], 40) : "";
  const hint = typeof raw["risk_hint"] === "string" ? normEnum(raw["risk_hint"]) : "unknown";
  return {
    ok: true,
    value: {
      signs,
      era: eraRaw && eraRaw.toLowerCase() !== "unknown" ? eraRaw : null,
      risk_hint: (RISKS as readonly string[]).includes(hint) ? (hint as Risk) : "unknown",
      search_terms: stringList(raw, "search_terms", 2, 40),
      material_hint: nullableStr(raw, "material_hint", 40),
      rarity_hint: ((): AuthenticityReport["rarity_hint"] => { const r = typeof raw["rarity_hint"] === "string" ? normEnum(raw["rarity_hint"]) : ""; return r === "common" || r === "unknown" || r === "rare" || r === "very_rare" ? r : null; })(),
    },
  };
}
