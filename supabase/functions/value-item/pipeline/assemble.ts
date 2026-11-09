import type { AuthenticityReport, BrainResult, DetailReport, Finding, Identification, JudgeVerdict, ResultComparable } from "../types.ts";
import { EMPTY_EVIDENCE, type Evidence, checkResult } from "../check.ts";
import type { FallbackLevel, IntervalOutput, RawComp } from "../interval.ts";
import { IDENTITY_CONF_BELOW } from "../interval.config.ts";
import { type Lang, T } from "../lang.ts";
import { type MarketState, buildFactors } from "../present.ts";
import { type OffsetTable, lookupOffset } from "../../_shared/offsets.ts";
import { type RecipeSource, buildFusedInterval } from "../fused-interval.ts";
import { conditionScore, confidenceLabel, quantile } from "../numbers.ts";
import { marketBasis } from "../market-tiers.ts";
import { valuationModeOf } from "../anchor.ts";
import { variantAmbiguityOf } from "../ad-calibration.ts";
import { variantDiffShare } from "../judge-schema.ts";
import { explainFactsOf, matchOfAd } from "../market-ads.ts";

// The default "take a better photo" sentence lives in lang.ts (T(lang).needsPhoto), in both languages.
// ---------------------------------------------------------------- pure assembly (easy to test)

export function needsPhotoResult(ident: Identification | null, degraded: string[], lang?: Lang, message?: string): BrainResult {
  return {
    status: "needs_photo",
    phase: "verified",
    itemName: ident?.display_name ?? "",
    category: ident?.category ?? "",
    brand: "",
    model: null,
    condition: "good",
    conditionScore: conditionScore("good"),
    currency: "USD",
    low: 0,
    mid: 0,
    high: 0,
    confidenceScore: 0,
    confidence: "low",
    needsMoreInfo: message ?? T(lang).needsPhoto,
    factors: [],
    comparables: [],
    degraded,
    authenticityFlag: "none",
    fromMemory: false,
  };
}

/** What the Judge kept, as evidence for the code check. */
/** New item in new condition: the shop price is the real price. Pure. */
export function isRetailNew(ident: Identification | null | undefined, conditionGrade: string | null | undefined): boolean {
  return !!ident && ident.age_class === "new" && conditionGrade === "new";
}

export function evidenceFrom(verdict: JudgeVerdict | null, findings: Finding[], newItem = false): Evidence {
  if (!verdict) return { ...EMPTY_EVIDENCE };
  const same = new Set(verdict.same);
  const kept = findings.filter((f) => same.has(f.id));
  return {
    keptSoldUsd: kept.filter((f) => f.kind === "sold").map((f) => f.priceUsd),
    keptAskingUsd: kept.filter((f) => f.kind !== "sold").map((f) => f.priceUsd),
    keptTitles: kept.map((f) => f.title),
    judgeRan: true,
    fromMemory: false,
    ...(newItem ? { newItem: true } : {}),
  };
}

function comparablesOf(verdict: JudgeVerdict, findings: Finding[]): ResultComparable[] {
  const same = new Set(verdict.same);
  const labelOf = new Map((verdict.ads ?? []).map((a) => [a.id, a]));
  return findings
    .filter((f) => same.has(f.id))
    .slice(0, 5)
    .map((f) => {
      const match = matchOfAd(labelOf.get(f.id) ?? { match: "same" });
      return { title: f.title, kind: f.kind, url: f.url, price: f.priceUsd, origin: f.origin, tier: f.tier, ...(match !== undefined ? { match } : {}) };
    });
}

export interface AssembleArgs {
  /** Number of consistency rules that fired (consistency.ts). */
  judgeDisagreements?: number;
  verdict: JudgeVerdict;
  ident: Identification | null;
  details: DetailReport | null;
  findings: Finding[];
  marketState: MarketState;
  soldTarget: number;
  degraded: string[];
  judgeRan: boolean;
  /** Identification's confidence (0-100). Low means the exact model is uncertain. */
  identConfidence?: number | null;
  /** Fallback for comparables that carry no tier (old data). New comparables carry their own tier. Default: local. */
  fallbackLevel?: FallbackLevel;
  /** The user's market (ISO alpha-2) or null. Saved with the result as `market.country`. */
  country?: string | null;
  /** Language of the sentences written for the person. Missing = English. */
  lang?: Lang;
  /** Age in days of the saved listings when the findings came from Memory (marketState "memory"). */
  memoryAgeDays?: number;
  /** Condition-adjusted price (USD) per kept ad id, from math.ts. The listing itself stays unchanged on the result. */
  priceAdjust?: Map<number, number>;
  /** Authenticity eye output, shown as a "Construction and era" line. */
  authenticity?: AuthenticityReport | null;
  /** Calibration multiplier for the width, looked up by bucket. Default 1. */
  kOf?: (bucket: string) => number | null | undefined;
  /**
   * Learned price level and noise per country pair (l_price_offsets). Read when the recipe is built and
   * stored WITH each comparable (`shiftLn`, `extraStd`), so a backtest replays what really ran.
   * Missing or empty: no shift and the guessed FOREIGN_STD (nothing is applied without evidence).
   */
  priceOffsets?: () => OffsetTable | undefined;
  /**
   * Receives the engine's output and the exact recipe it was built from, for l_runs.steps.interval.
   * Save the recipe you are handed; never rebuild it (see IntervalRecipe).
   */
  onInterval?: (out: IntervalOutput, recipe: IntervalRecipe) => void;
  /** Independent anchors (Identification, neighbours) for the fused engine, as ln-USD sources. Stored in the recipe. */
  fusionSources?: RecipeSource[];
}

/** The comparables the interval engine works from. */
export function compsForInterval(
  verdict: JudgeVerdict,
  findings: Finding[],
  judgeRan: boolean,
  offsets?: { table: OffsetTable | undefined; user: string | null },
  adjust?: Map<number, number>,
): RawComp[] {
  const same = new Set(verdict.same);
  const similar = new Set(verdict.similar);
  const labelOf = new Map((verdict.ads ?? []).map((a) => [a.id, a]));
  const usable = findings.filter((f) => f.priceUsd > 0);
  // Without a Judge nothing is sorted: every priced listing counts, and the emergency range is
  // built from those same listings.
  const picked = judgeRan ? usable.filter((f) => same.has(f.id) || similar.has(f.id)) : usable;
  return picked.map((f) => {
    // Only a FOREIGN listing can carry a learned shift or noise, and only when its country pair has evidence.
    const learned = (f.tier ?? "local") !== "local" && offsets ? lookupOffset(offsets.table, f.origin, offsets.user) : null;
    return {
      priceUsd: adjust?.get(f.id) ?? f.priceUsd,
      kind: f.kind,
      match: judgeRan && similar.has(f.id) && !same.has(f.id) ? ("similar" as const) : ("same" as const),
      tier: f.tier,
      origin: f.origin,
      ...(judgeRan && labelOf.get(f.id)?.p_same ? { pSame: labelOf.get(f.id)!.p_same } : {}),
      ...(judgeRan && labelOf.get(f.id)?.ad_reliability ? { reliability: labelOf.get(f.id)!.ad_reliability } : {}),
      ...(judgeRan && labelOf.get(f.id)?.relative_value ? { relative: labelOf.get(f.id)!.relative_value } : {}),
      ...(learned ? { shiftLn: learned.shiftLn, ...(learned.extraStd !== null ? { extraStd: learned.extraStd } : {}) } : {}),
    };
  });
}

/**
 * Everything the interval engine reads, built in ONE place. `assemble` feeds it to `buildFusedInterval`
 * and `runBrain` saves the very same object in l_runs.steps.interval, so the backtest replays
 * exactly what production ran. If the engine needs a new input, add it here and nowhere else.
 *
 * Not part of the recipe on purpose: `k`/`kOf` (calibration changes over time and is stored as
 * `k` in the breakdown), `kM` and `sigmaCat` (constants). `v` is the shape version: a future
 * detail model adds its own fields under a new `v`, and readers skip versions they do not know.
 */
export interface IntervalRecipe {
  /** Shape version. 2 = the fused engine (the only engine; shape 1 belonged to the removed buildInterval and cannot be replayed). */
  v: 2;
  sources: RecipeSource[];
  model: { low: number; mid: number; high: number };
  modelConfidence: number;
  category: string;
  condition: string;
  authenticityRisk: string;
  unknownsCount: number;
  judgeDisagreements?: number;
  rarity?: string;
  /** 0..1, from the Judge's identity_certainty, variant_diffs, similar share and identification confidence. Stored so a replay is exact. */
  variantAmbiguity?: number;
  identitySimilar: boolean;
  fallbackLevel: FallbackLevel;
  /** Absent = ASKING_TO_SOLD (0.9). 1.0 only for a new item in new condition (isRetailNew). */
  askingToSold?: number;
  /** Calibration bucket suffix. Only set when the item is retail/auction; absent = resale (old bucket key). */
  mode?: "retail" | "auction";
  comps: RawComp[];
}

/** The one place that turns the Judge's verdict and the listings into the engine's input. */
export function intervalRecipeOf(a: AssembleArgs): IntervalRecipe {
  const v = a.verdict;
  const labelled = a.judgeRan ? (v.ads ?? []).filter((x) => x.match !== "different") : [];
  const variantAmbiguity = variantAmbiguityOf({
    identConfidence: a.identConfidence ?? null,
    identitySimilar: a.identConfidence !== null && a.identConfidence !== undefined && a.identConfidence < IDENTITY_CONF_BELOW,
    similarShare: labelled.length ? labelled.filter((x) => x.match === "similar").length / labelled.length : null,
    diffShare: variantDiffShare(labelled),
    certainty: a.judgeRan ? v.identity_certainty ?? null : null,
  });
  return {
    v: 2,
    variantAmbiguity,
    sources: a.fusionSources ?? [],
    model: { low: v.price.low, mid: v.price.mid, high: v.price.high },
    modelConfidence: v.confidence,
    category: v.category,
    condition: v.condition.grade,
    authenticityRisk: v.authenticity_risk,
    unknownsCount: v.unknowns.length,
    ...(a.ident?.rarity ? { rarity: a.ident.rarity } : {}),
    ...(a.judgeDisagreements ? { judgeDisagreements: a.judgeDisagreements } : {}),
    identitySimilar: a.identConfidence !== null && a.identConfidence !== undefined && a.identConfidence < IDENTITY_CONF_BELOW,
    // Every comparable carries its own tier now (market-tiers.ts); this is only the fallback for old data.
    fallbackLevel: a.fallbackLevel ?? "local",
    ...(isRetailNew(a.ident, v.condition.grade) ? { askingToSold: 1 } : {}),
    ...(valuationModeOf(a.ident) !== "resale" ? { mode: valuationModeOf(a.ident) as "retail" | "auction" } : {}),
    comps: compsForInterval(v, a.findings, a.judgeRan, { table: a.priceOffsets?.(), user: a.country ?? null }, a.priceAdjust),
  };
}

/** Judge in, checked USD result out. */
export function assemble(a: AssembleArgs): BrainResult {
  const v = a.verdict;
  const ev = a.judgeRan ? evidenceFrom(v, a.findings, isRetailNew(a.ident, v.condition.grade)) : { ...EMPTY_EVIDENCE };

  // The interval engine turns the Judge's range and the real listings into one 80 percent range
  // and the one confidence score. Its input is built once, here, and the same
  // object is handed to onInterval so it can be saved for replay.
  const recipe = intervalRecipeOf(a);
  const iv = buildFusedInterval({ ...recipe, kOf: a.kOf });
  a.onInterval?.(iv, recipe);

  // A Judge that ran out of time never wrote its own confidence (a placeholder was filled in).
  // The score then may not rise above that placeholder, however tight the listings are.
  const judgeConfidenceMissing = v.missing?.includes("confidence") === true;
  const score = judgeConfidenceMissing ? Math.min(iv.confidenceScore, v.confidence) : iv.confidenceScore;

  const base: BrainResult = {
    status: "ok",
    phase: "verified",
    itemName: v.display_name,
    category: v.category,
    brand: v.brand ?? a.ident?.brand ?? "",
    model: v.model ?? a.ident?.model ?? null,
    condition: v.condition.grade,
    conditionScore: conditionScore(v.condition.grade),
    currency: "USD",
    low: iv.low,
    mid: iv.mid,
    high: iv.high,
    confidenceScore: score,
    confidence: confidenceLabel(score),
    needsMoreInfo: null,
    intervalLevel: iv.intervalLevel,
    widthDrivers: iv.widthDrivers,
    factors: buildFactors({
      verdict: v,
      details: a.details,
      findings: a.findings,
      marketState: a.marketState,
      soldTarget: a.soldTarget,
      needsMoreInfo: null,
      lang: a.lang,
      memoryAgeDays: a.memoryAgeDays,
      authenticity: a.authenticity,
    }),
    comparables: comparablesOf(v, a.findings),
    degraded: a.degraded,
    authenticityFlag: "none",
    fromMemory: false,
    explain: explainFactsOf({ ident: a.ident, authenticity: a.authenticity, verdict: v, midUsd: iv.mid, identConfidence: a.identConfidence ?? a.ident?.confidence }),
    // Which market this price belongs to, and where its evidence came from. Saved with the valuation,
    // so a price made from foreign listings is never shown as a local one.
    market: {
      ...marketBasis(a.country ?? null, recipe.comps),
      // True when a learned price-level shift moved at least one foreign comparable (see _shared/offsets.ts).
      ...(recipe.comps.some((c) => (c.shiftLn ?? 0) !== 0) ? { adjusted: true } : {}),
    },
  };

  const checked = checkResult(base, ev, v.authenticity_risk, true, a.lang);

  let needsMoreInfo: string | null = null;
  if (checked.confidenceScore < 40 || iv.needsMoreInfo) {
    needsMoreInfo = v.extra_photo_request ?? T(a.lang).closerPhoto;
  } else if (checked.confidenceScore < 60 && v.extra_photo_request) {
    needsMoreInfo = v.extra_photo_request;
  }
  if (needsMoreInfo) {
    return { ...checked, needsMoreInfo, factors: [...checked.factors, { label: T(a.lang).labels.improve, detail: needsMoreInfo }] };
  }
  return checked;
}

/**
 * Emergency answer when the Judge cannot run or fails: only possible when Market Live found at
 * least three priced listings. Nothing is invented: the range is the spread of real listings,
 * the confidence is low, and the result says so. Never saved to Memory.
 */
export function emergencyVerdict(
  ident: Identification | null,
  details: DetailReport | null,
  findings: Finding[],
  lang?: Lang,
  askingToSold = 0.9,
): JudgeVerdict | null {
  const usable = findings.filter((f) => f.kind === "sold" || f.priceUsd > 0);
  const prices = usable.map((f) => (f.kind === "sold" ? f.priceUsd : f.priceUsd * askingToSold));
  if (!ident || !ident.identifiable || prices.length < 3) return null;
  const low = quantile(prices, 0.25);
  const mid = quantile(prices, 0.5);
  const high = quantile(prices, 0.75);
  if (!(low > 0)) return null;
  return {
    identifiable: true,
    display_name: ident.display_name,
    category: ident.category,
    brand: ident.brand,
    model: ident.model,
    condition: details?.condition ?? { grade: "good", details: "" },
    same: [],
    similar: [],
    price: { low, mid, high },
    confidence: 30,
    authenticity_risk: "unknown",
    authenticity_note: "",
    unknowns: [T(lang).emergency.unknown],
    extra_photo_request: null,
    reason: T(lang).emergency.reason,
  };
}
