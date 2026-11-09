// Estimate mode: a price with NO market data. Haiku supplies bounded, labelled FACTS
// (typical new price, basis, age class, rarity); this pure code turns them into a number. Deterministic, no network.
// Every table lives in interval.config.ts. The result feeds buildInterval as the model with comps: [] (marketAbsent path).

import * as C from "./interval.config.ts";
import { MAX_PRICE } from "./validate.ts";

export interface AnchorInput {
  new_price_usd: number | null | undefined;
  new_price_basis: string | null | undefined; // known_model | brand_category_typical | comparable_objects | none
  category: string;
  age_class: string | null | undefined;
  condition: string | null | undefined;
  rarity: string | null | undefined;
}

export interface AnchorResult {
  mid: number;
  /** ln-spread of the anchor itself (feeds the interval as the model spread). */
  lnStd: number;
  rarity: string;
  basis: string;
  parts: { anchor: number; depreciation: number; conditionMult: number; rarityMult: number };
}

/** True when the item is valued as a collectible or rare object, not as ordinary resale goods: the new-price anchors of ordinary goods are then a weak yardstick for its listings. Pure. */
export function isCollectorLike(ident: { age_class?: string | null; rarity?: string | null; new_price_basis?: string | null } | null | undefined): boolean {
  if (!ident) return false;
  return ident.age_class === "vintage" || ident.age_class === "antique" || ident.rarity === "rare" || ident.rarity === "very_rare" || ident.new_price_basis === "comparable_objects";
}

/** Valuation mode of an item: "retail" (new), "auction" (collectible / rare / antique / reference-priced), else "resale". Pure; resale is the default and never changes behaviour. */
export type ValuationMode = "resale" | "retail" | "auction";
export function valuationModeOf(ident: { age_class?: string | null; rarity?: string | null; new_price_basis?: string | null } | null | undefined): ValuationMode {
  if (!ident) return "resale";
  if (isCollectorLike(ident)) return "auction";
  return ident.age_class === "new" ? "retail" : "resale";
}

/** Valid anchor or null. Never guesses: bad, missing or out-of-bounds input gives null. */
export function anchorEstimate(i: AnchorInput): AnchorResult | null {
  const a = i.new_price_usd;
  if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) return null;
  const basis = i.new_price_basis && i.new_price_basis in C.ANCHOR_BASIS_STD ? i.new_price_basis : "none";
  if (basis === "none") return null;
  // comparable_objects: the price is already a MARKET VALUE (antique, collectible, unique or industrial item with no retail price,
  // or worth more than new). It is never depreciated and its rarity is already inside the value. Every other basis is a NEW price.
  const reference = basis === "comparable_objects";
  if (a < C.ANCHOR_MIN_USD || a > MAX_PRICE) return null;
  const age = (C.AGE_CLASSES as readonly string[]).includes(i.age_class ?? "") ? (i.age_class as C.AgeClass) : "unknown";
  // A brand-new item sold new is worth about its retail price: no used-goods depreciation and no condition premium on top of it.
  const retailNew = !reference && age === "new" && i.condition === "new";
  const depreciation = reference || retailNew ? 1 : C.DEPRECIATION_BY_AGE[age] * (C.DEPRECIATION_CATEGORY_MULT[i.category] ?? 1);
  const conditionMult = retailNew ? 1 : C.CONDITION_MULT[i.condition ?? "unknown"] ?? C.CONDITION_MULT.unknown;
  const rarity = i.rarity && i.rarity in C.RARITY_MULT ? i.rarity : "unknown";
  const rarityMult = reference ? 1 : C.RARITY_MULT[rarity];
  const mid = a * depreciation * conditionMult * rarityMult;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return { mid, lnStd: C.ANCHOR_BASIS_STD[basis] + (age === "unknown" ? 0.1 : 0), rarity, basis, parts: { anchor: a, depreciation, conditionMult, rarityMult } };
}

import { Z80 } from "./interval.config.ts";
import type { AuthenticityReport, DetailReport, Identification, JudgeVerdict } from "./types.ts";
import type { Lang } from "./lang.ts";
import { T } from "./lang.ts";

/**
 * Estimate verdict for "Serper found nothing". Pure. null when the item has no usable anchor:
 * the caller then asks for a photo with the SPECIFIC message (no market data and unclear item).
 * Risk is never "low": nothing was checked against the market.
 */
export function estimateVerdict(ident: Identification | null, details: DetailReport | null, lang?: Lang): { verdict: JudgeVerdict; rarity: string; lnStd: number } | null {
  if (!ident || !ident.identifiable) return null;
  const cond = details?.condition ?? { grade: "good" as const, details: "" };
  const r = anchorEstimate({
    new_price_usd: ident.new_price_usd,
    new_price_basis: ident.new_price_basis,
    category: ident.category.toLowerCase(),
    age_class: ident.age_class,
    condition: cond.grade,
    rarity: ident.rarity,
  });
  if (!r) return null;
  const std = r.lnStd;
  return {
    rarity: r.rarity,
    lnStd: std,
    verdict: {
      identifiable: true,
      display_name: ident.display_name,
      category: ident.category,
      brand: ident.brand,
      model: ident.model,
      condition: cond,
      same: [],
      similar: [],
      price: { low: r.mid * Math.exp(-Z80 * std), mid: r.mid, high: r.mid * Math.exp(Z80 * std) },
      confidence: 15,
      authenticity_risk: "unknown",
      authenticity_note: "",
      unknowns: [T(lang).estimate.neighbourUnknown],
      extra_photo_request: T(lang).closerPhoto,
      reason: T(lang).estimate.neighbourReason,
    },
  };
}

/**
 * Rung 4 of the estimate ladder: no ads AND no usable price anchor, but similar past scans exist (neighbour-prior.ts).
 * Returns the same shape as estimateVerdict: a very wide, low-confidence verdict centred on the neighbours' typical price,
 * ln sd = the prior's own sd + 0.15 (nothing was checked on the market for THIS item). Risk is never "low". Null when the item
 * is not identifiable or the prior is unusable. The price is made by code from the neighbours, never by a model.
 */
export function neighbourEstimateVerdict(ident: Identification | null, details: DetailReport | null, nb: { mu: number; sd: number } | null, lang?: Lang): { verdict: JudgeVerdict; rarity: string; lnStd: number } | null {
  if (!ident || !ident.identifiable || !nb || !Number.isFinite(nb.mu) || !Number.isFinite(nb.sd) || nb.sd <= 0) return null;
  const mid = Math.exp(nb.mu);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const std = Math.min(1.2, nb.sd + 0.15);
  const cond = details?.condition ?? { grade: "good" as const, details: "" };
  return {
    rarity: "unknown",
    lnStd: std,
    verdict: {
      identifiable: true,
      display_name: ident.display_name,
      category: ident.category,
      brand: ident.brand,
      model: ident.model,
      condition: cond,
      same: [],
      similar: [],
      price: { low: mid * Math.exp(-Z80 * std), mid, high: mid * Math.exp(Z80 * std) },
      confidence: 10,
      authenticity_risk: "unknown",
      authenticity_note: "",
      unknowns: [T(lang).estimate.neighbourUnknown],
      extra_photo_request: T(lang).closerPhoto,
      reason: T(lang).estimate.neighbourReason,
    },
  };
}


/** Age class from an era text such as "1970s", "Victorian", "1890". Null when unsure. Pure. */
export function ageClassFromEra(era: string | null | undefined): "vintage" | "antique" | null {
  if (!era) return null;
  const e = era.toLowerCase();
  if (/victorian|edwardian|georgian|regency|art nouveau|antique/.test(e)) return "antique";
  const m = e.match(/\b(1[5-9]\d\d|20[0-2]\d)(?!\d)/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y <= 1925) return "antique";
  if (y <= 1995) return "vintage";
  return null;
}

/**
 * Authenticity eye extension: fills ONLY the facts Identification left empty (material, rarity, age class) from the
 * Authenticity eye. Never overrides what Identification said, never touches the price anchor. Pure, input not mutated.
 */
export function mergeEyeFacts(ident: Identification | null, auth: AuthenticityReport | null): Identification | null {
  if (!ident || !auth) return ident;
  const material = ident.material ?? auth.material_hint ?? null;
  const rarity = ident.rarity ?? auth.rarity_hint ?? null;
  const age = ident.age_class ?? ageClassFromEra(auth.era);
  if (material === (ident.material ?? null) && rarity === (ident.rarity ?? null) && age === (ident.age_class ?? null)) return ident;
  return { ...ident, material, rarity, age_class: age } as Identification;
}
