// Shared types for the Brain (see Brain_Detailed.png).
//
// Flow, in the words of the diagram:
//   Photo -> Protection
//   Photo -> Detail eye + Identification (parallel) and Photo -> Judge (direct)
//   Detail eye -> Judge and the Memory gate. Identification -> Memory only.
//   Memory HIT (Detail eye agrees) -> Check and exchange rates. Memory JUDGE (condition one grade off) -> Judge on the
//   saved listings. Memory MISS -> Market Live <-> Search AI.
//   Market Live -> Judge -> Check and exchange rates -> Answer -> Saved (new valuations only).
//
// All money inside the Brain is US dollars. Only the very last step converts to the user's currency.

export const GRADES = ["new", "like-new", "good", "fair", "poor"] as const;
export type Grade = (typeof GRADES)[number];

export const RISKS = ["low", "medium", "high", "unknown"] as const;
export type Risk = (typeof RISKS)[number];

export const LISTING_KINDS = ["sold", "asking"] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export interface PriceRange {
  low: number;
  mid: number;
  high: number;
}

// ---------------------------------------------------------------- input

export interface BrainInput {
  imageMediaType: string;
  imageBase64: string;
  /** ISO 3166-1 alpha-2 of the user's market, if known. Sold listings are searched per country. */
  country: string | null;
  /** Language of the words written for the person ("sv" for a Swedish phone, else "en"). Missing = English. */
  lang?: "sv" | "en";
}

// ---------------------------------------------------------------- Eyes

export const DETAIL_KINDS = ["logo", "stamp", "seam", "label", "serial", "material", "damage", "other"] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export interface DetailNote {
  kind: DetailKind;
  text: string;
}

/** Output of the Detail eye. Goes to the Judge and to the Memory gate. */
export interface DetailReport {
  details: DetailNote[];
  condition: { grade: Grade; details: string };
  /** Signs that point towards a fake or a genuine item. */
  authenticity_signals: string[];
}

/**
 * The Authenticity eye. It reports ONLY what the Detail eye and Identification miss: signs of a fake or replica, era
 * and age from construction, repaired or replaced parts, rarity or limited edition, original versus later-made,
 * inconsistencies (a logo or part that does not fit the model), material and quality cues. It never reads stamps, hallmarks,
 * serials, logos or other text (the Detail eye does that) and never names the item (Identification does). Never sees or says a price.
 */
export const AUTH_SIGN_KINDS = ["fake_sign", "construction", "repair", "originality", "inconsistency", "material", "rarity", "other"] as const;
export type AuthSignKind = (typeof AUTH_SIGN_KINDS)[number];
export interface AuthenticityReport {
  /** What the construction, wear and parts say (never text read from the item). At most 5. */
  signs: { kind: AuthSignKind; text: string }[];
  /** Estimated era or age from construction, e.g. "1970s", or null. */
  era: string | null;
  /** The eye's own hint of fake risk. The Judge decides the final label. */
  risk_hint: Risk;
  /** 0-2 short words worth adding to a search, only from era, rarity or construction (never a mark, maker or text). */
  search_terms: string[];
  /** Optional and null when unclear: old answers validate without them. Facts only; code makes the price. */
  material_hint?: string | null;
  rarity_hint?: "common" | "unknown" | "rare" | "very_rare" | null;
}

export type AdMatch = "same" | "similar" | "different";
/** Our item compared with the ad's item: worse / equal / better. */
export type AdCondition = "worse" | "equal" | "better";
export interface AdLabel {
  id: number;
  match: AdMatch;
  /** Derived from relative_value when the Judge gave a band (worse < 0.97, better > 1.03); the Judge's own answer for old output. */
  condition_vs_ad: AdCondition;
  /** Nine-band worth of the photo item vs this ad (ad-calibration.ts RELATIVE_FACTOR). Optional: old answers validate without it. */
  relative_value?: "much_worse" | "clearly_worse" | "worse" | "slightly_worse" | "equal" | "slightly_better" | "better" | "clearly_better" | "much_better";
  /** JudgeReport v2 (all optional: old answers validate). Bands only; ad-calibration.ts maps them to numbers. */
  p_same?: "certain" | "likely" | "unsure" | "unlikely" | "no";
  ad_reliability?: "high" | "normal" | "low";
  variant_diffs?: string[];
}

/** The item fingerprint. Used for Memory and for the Search AI. Never contains photos or user data. */
export interface Fingerprint {
  category: string;
  brand: string | null;
  type: string;
  model: string | null;
  era: string | null;
  /** The user's market (ISO alpha-2), or "ZZ" when unknown. */
  country: string;
  /** Main language of that market (ISO 639-1). */
  language: string;
  /** Valuation mode, set ONLY for non-resale items. Absent = resale. Not part of memoryKey. */
  mode?: "retail" | "auction";
}

/** Output of Identification. Goes only to Memory (and from there to Market Live). */
export interface Identification {
  identifiable: boolean;
  what_is_it: string;
  display_name: string;
  category: string;
  type: string;
  brand: string | null;
  model: string | null;
  era: string | null;
  origin_country: string | null;
  /** How sure Identification is about brand/type (0-100). */
  confidence: number;
  google_queries: string[];
  /** Estimate-mode facts. Bounded labelled facts, NEVER the answer: code (anchor.ts) makes the price. null = not readable. */
  new_price_usd?: number | null;
  new_price_basis?: "known_model" | "brand_category_typical" | "comparable_objects" | "none" | null;
  material?: string | null;
  rarity?: "common" | "unknown" | "rare" | "very_rare" | null;
  age_class?: string | null;
}

// ---------------------------------------------------------------- Search AI

export type SearchKind = "exploit" | "experiment" | "fixed";

export interface PlannedSearch {
  /** why the Brain added this search ("eyes_evidence" | "eyes_no_evidence"). Logged in steps.eyeSearch. */
  reason?: string;
  id: string; // s1..s4
  query: string;
  template_id: string;
  kind: SearchKind;
  /** Google country (gl) and language (hl) for this search. */
  gl: string;
  hl: string;
  /** Set only on searches Market Live added itself when the local ones found too little (country ladder). */
  tier?: "local" | "regional" | "global";
}

export interface SearchPlan {
  /** null when the fixed templates were used. */
  strategyVersion: number | null;
  source: "search_ai" | "fixed";
  searches: PlannedSearch[];
  /** searches added by the Brain itself (the mandatory eye-evidence search). Counted against HARD_CAPS.searchesTotal. Never part of the Search AI plan. */
  extraSearches?: PlannedSearch[];
  stop: { soldPrices: number; maxMs: number };
}

// ---------------------------------------------------------------- Market Live

/** One priced listing found by Market Live. Prices are extracted by code, never by AI. */
export interface Finding {
  /** Number the Judge uses to refer to this finding (1..n). */
  id: number;
  searchId: string;
  title: string;
  snippet: string;
  url: string;
  site: string;
  kind: ListingKind;
  /** Price as shown on the page. */
  price: number;
  currency: string;
  /** The same price in USD, with today's exchange rate. */
  priceUsd: number;
  /** The country the search was aimed at. */
  gl: string;
  /** The country the listing itself belongs to (decided by the page first, the search second). */
  origin: string;
  /** local = the user's country, regional = a neighbouring market, global = anywhere else. */
  tier: "local" | "regional" | "global";
}

export interface SearchOutcome {
  search: PlannedSearch;
  /** Number of organic results returned. */
  resultCount: number;
  soldCount: number;
  latencyMs: number;
  /** true when the stopper cancelled this search before it answered. */
  cancelled: boolean;
  failed: boolean;
  /**
   * E2 (overlap), report-only: short salted hashes of the listing links this search returned (at most 10, no raw links).
   * Only present when the pipeline asked for it (always, the Connector is always on). Goes to l_connector_log ONLY: never to
   * l_runs (steps) and never to l_search_log.
   */
  hitKeys?: string[];
  /**
   * Race-free credit, for both learners: the sold prices (USD) this search returned ITSELF, in Google's order, at most 5.
   * It includes listings another search delivered first, which `findings` leaves out. Present for every search that
   * answered (whatever the Connector mode); absent when the search failed or was cancelled. `key` (the salted listing hash,
   * comparable only inside one valuation) is added only when the pipeline asked for overlap data (always, the Connector is always on).
   * The Search AI's log gets the prices only (`l_search_log.own_sold`); keys go to l_connector_log only and never to
   * l_runs or l_search_log.
   */
  ownSold?: { key?: string; usd: number }[];
}

export type StopReason = "target" | "time" | "done" | "no_searches";

export interface MarketReport {
  findings: Finding[];
  outcomes: SearchOutcome[];
  soldCount: number;
  stopReason: StopReason;
  elapsedMs: number;
  /** Findings dropped because the price could not be read or the link was a duplicate. */
  droppedCount: number;
  /** Tiers Market Live had to go to, in order. ["local"] means the user's own country was enough. */
  tiersUsed: ("local" | "regional" | "global")[];
  /** Sold prices counted by how well they speak for the user's country (see market-tiers.ts). */
  effectiveSold: number;
  /** The Authenticity eye's search: only when the market was thin after wave 1; `replaced` = the weakest Search-AI search it stands in for. */
  eyeSearch?: { ran: boolean; replaced: string | null; reason: string };
}

// ---------------------------------------------------------------- Judge

export interface JudgeVerdict {
  identifiable: boolean;
  display_name: string;
  category: string;
  brand: string | null;
  model: string | null;
  condition: { grade: Grade; details: string };
  /** Finding ids that are the very same item. */
  same: number[];
  /** Finding ids that are a similar but not identical item. */
  similar: number[];
  /** USD. NEVER written by the Judge (Haiku): set by code in math.ts from the labelled ads. */
  price: PriceRange;
  /** 0-100. NEVER written by the Judge: set by code in math.ts (count, spread, risk). */
  confidence: number;
  /** The Judge's per-ad labels (diagram: same item? / worse-equal-better). Code does all arithmetic on them. */
  ads?: AdLabel[];
  /** Did the text the eyes read match the photo? Mismatching items are listed. */
  eye_text_mismatch?: string[];
  /** JudgeReport v2: how sure the Judge is of the exact variant. Feeds variantAmbiguity (never a price). */
  identity_certainty?: "high" | "medium" | "low";
  authenticity_risk: Risk;
  authenticity_note: string;
  unknowns: string[];
  extra_photo_request: string | null;
  reason: string;
  /** Fields the Judge did not get to write before the time ran out. Empty for a complete answer. */
  missing?: string[];
}

// ---------------------------------------------------------------- Result

export interface FactorLine {
  label: string;
  detail: string;
}

export interface ResultComparable {
  title: string;
  kind: ListingKind | "unknown";
  url: string;
  /** In the currency of the result, as shown on the page (converted, not adjusted). */
  price: number;
  /** Country of the listing (ISO alpha-2) and its tier. Missing on results saved before country adaptation. */
  origin?: string;
  tier?: "local" | "regional" | "global";
  /** 0..1: how well this ad matches the item (from the Judge's p_same band). Missing = unknown, and the ad never counts as market data. */
  match?: number;
}

/** Facts the "Så värderade vi" paragraph may use. null = unknown: the writer must not mention it. */
export interface ExplainFacts {
  era: string | null;
  origin: string | null;
  material: string | null;
  /** Identification's own confidence, 0-100. */
  identConfidence: number | null;
  antique: boolean;
  highValueOrAntique: boolean;
  grade: Grade;
}

export type AuthenticityFlag = "none" | "check" | "high";

export interface BrainResult {
  status: "ok" | "needs_photo";
  /** Kept so the app and old rows still parse. A finished answer is always "verified". */
  phase: "quick" | "verified";
  itemName: string;
  category: string;
  brand: string;
  model: string | null;
  condition: Grade;
  conditionScore: number; // 0-1
  /** "USD" inside the Brain. Converted to the user's currency just before sending. */
  currency: string;
  low: number;
  mid: number;
  high: number;
  confidenceScore: number; // 0-100
  confidence: "low" | "medium" | "high";
  needsMoreInfo: string | null;
  factors: FactorLine[];
  comparables: ResultComparable[];
  degraded: string[];
  /** Set by the code check. */
  authenticityFlag: AuthenticityFlag;
  /** True when Memory recognised the item and the Brain (Market Live and Judge) was skipped. */
  fromMemory: boolean;
  /** Which exchange rates were used for the conversion. Set when the result is localized. */
  fx?: { source: "live" | "cached" | "fallback"; asOf: string | null };
  /** low..high is the central 80 percent range. Missing on results saved before the interval engine. */
  intervalLevel?: 0.8;
  /** Up to two codes (see interval.ts) that explain why the range is as wide as it is. */
  widthDrivers?: string[];
  /** Facts for the explanation paragraph (see market-ads.ts). Missing on Memory hits and old rows. */
  explain?: ExplainFacts;
  /** Ads that passed the match bar (at most MARKET_MAX_ADS). Empty = show the explanation link instead of the market link. Set by the handler. */
  marketAds?: ResultComparable[];
  /** The minimum number of ads the server asks for (MARKET_MIN_ADS), so the app can still decide after it removed a dead link. */
  minAds?: number;
  /**
   * Which market the price belongs to and where its evidence came from. Saved with the valuation so a
   * price made from foreign listings is never shown as a local one. Missing on old results (treat as unknown).
   */
  market?: {
    country: string;
    basis: "local" | "regional" | "global" | "none";
    local: number;
    regional: number;
    global: number;
    /** True when a learned price-level shift moved the foreign comparables toward the user's price level. */
    adjusted?: boolean;
  };
}

/** One row for the search log that feeds the nightly learner. Item fingerprints only. */
export interface SearchLogRow {
  strategy_version: number | null;
  source: "search_ai" | "fixed";
  fingerprint: Fingerprint;
  /** The query the PLAN chose (the template's own text). Never the Connector's edit. */
  query: string;
  /** The query that really went to Serper. Equal to `query` unless the Connector edited it. */
  executed_query: string;
  /** True when executed_query differs from query. The Search AI ignores such rows when crediting a template. */
  connector_modified: boolean;
  template_id: string;
  kind: SearchKind;
  gl: string;
  hl: string;
  /** Tier of the search relative to the user's country. Lets the learner see what each country needs. */
  tier?: "local" | "regional" | "global";
  site: string | null;
  result_count: number;
  sold_count: number;
  kept_sold: number;
  kept_asking: number;
  discarded: number;
  prices: { usd: number; kind: ListingKind; verdict: "same" | "similar" | "different" }[];
  /**
   * The search's OWN sold prices in USD (plain numbers, at most 5, Google's order), including listings that another
   * parallel search delivered first and `prices` therefore does not hold. null = not recorded (old rows, failed or
   * cancelled searches). The Search AI's learner credits a search from this when it is an array. Never holds keys or links.
   */
  own_sold: number[] | null;
  latency_ms: number;
  cost_usd: number;
  cancelled: boolean;
  stop_reason: StopReason;
  /** false when the Judge did not answer, so "kept" is unknown and the learner must skip the row. */
  judge_ok: boolean;
}

/** One row of l_connector_log: what the Connector proposed and did, and what each search found. Fingerprint only. */
export interface ConnectorLogRow {
  run_id: string | null;
  brain_version: string;
  /** "shadow" only exists in OLD rows written before the Connector was always on; new rows are always "on". */
  mode: "shadow" | "on";
  applied: boolean;
  control: boolean;
  held_back: boolean;
  draw: number;
  share: number;
  effective_share: number;
  dial: number | null;
  bucket: string;
  source: "search_ai" | "fixed";
  strategy_version: number | null;
  fingerprint: Fingerprint;
  haiku_query: string | null;
  local_name: string | null;
  proposed_changes: number;
  /** One entry per planned search: queries, rule, and what the search found (kept_sold, discarded ...). */
  searches: Record<string, unknown>[];
  judge_ok: boolean;
  /** Weighted yield of the valuation (see connector-learn.ts). Null when the Judge did not answer. */
  reward: number | null;
}

/** Everything the Brain produced, for storage and later learning. */
export interface BrainRun {
  result: BrainResult;
  /** Present only for a Memory MISS that ran the Brain. Null for hits. */
  memoryHit: boolean;
  fingerprint: Fingerprint | null;
  /** Only new valuations are saved. A Memory hit is never saved again. */
  saveable: boolean;
  /** True if later requests may be answered from this valuation through Memory. */
  memoryEligible: boolean;
  /** Id of the stored valuation that answered a Memory hit. */
  memoryRunId: string | null;
  steps: Record<string, unknown>;
  searchLog: SearchLogRow[];
  /** The Connector's own log row (whenever the Connector ran). The handler adds run_id. */
  connectorLog?: ConnectorLogRow | null;
}

export class StepError extends Error {
  step: string;
  detail: string[];
  constructor(step: string, message: string, detail: string[] = []) {
    super(`${step}: ${message}`);
    this.name = "StepError";
    this.step = step;
    this.detail = detail;
  }
}

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}
