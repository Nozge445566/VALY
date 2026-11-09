// Configuration for the Brain. Everything comes from environment variables (Supabase secrets),
// so no key ever lives in the app code or in the browser.

import { CONNECTOR_RULE_IDS } from "../_shared/connector-learn.ts";
import type { ConnectorRuleId } from "../_shared/connector-learn.ts";

/** Bump this when prompts or scoring change. */
export const BRAIN_VERSION = "brain-5.2.0";

/**
 * Memory only trusts valuations made by a Brain at least this new. The stricter Memory rules (4.1.0) must not be
 * bypassed by rows that were saved under the looser rules before them. [major, minor, patch]
 */
export const MEMORY_MIN_BRAIN_VERSION: readonly [number, number, number] = [5, 1, 0]; // 5.1: prices changed meaning (Judge-driven math, estimate mode). Brain 4.x and 5.0 memory is ignored.

/** Hard caps from the diagram. Nothing in the environment can raise these. */
export const HARD_CAPS = {
  /** "Answer at 7 s, hard limit" */
  answerMs: 7000,
  /** Search AI: "Hard caps: 4 searches, 2.0 s, one experiment slot." */
  searches: 4,
  searchMs: 2000,
  experimentSlots: 4,
  /**
   * Country ladder: the Search AI still plans at most 4 searches (above). Market Live may add up to
   * 3 more (one parallel global search for thin countries, then regional and global when the local
   * ones found too little), all inside the same 2.0 s window.
   */
  searchesTotal: 7,
  /** Search AI: "stops at 5 sold prices". */
  soldPrices: 5,
} as const;

export interface BrainConfig {
  anthropicKey: string;
  /** Serper (Google) key for Market Live. Without it the Brain falls back to the no-market ladder (neighbour prior, eye/Judge anchor estimate). */
  serperKey: string | null;
  /** Detail eye and Identification. Diagram: Claude Haiku 5.5. */
  eyesModel: string;
  /** The Judge. Diagram: Claude Haiku 5.5 (labels only; code does the maths). */
  judgeModel: string;
  /**
   * How hard the Judge thinks: adaptive thinking steered by output_config.effort (Haiku 5.5 takes no token budget).
   * Default "auto": code picks medium or high per scan from signals that are already known (judge.ts::pickEffort, no extra
   * model call, never off). "off", "low", "medium" and "high" are manual overrides that apply to every scan ("off" = thinking disabled).
   */
  judgeEffort: JudgeEffortSetting;
  /** Hard time limit for the whole answer, in ms. Diagram: 7 s. */
  answerMs: number;
  /** Eyes target window. Diagram: 0 to 1.5 s. */
  eyesMs: number;
  /** Search window. Diagram: stops at 2.0 s. */
  searchMs: number;
  /** Time the Judge is guaranteed at least (if Identification is on time). The search is shortened to protect it. */
  judgeTargetMs: number;
  /** Optional extra exchange-rate source (JSON with a `rates` object). */
  fxUrl: string | null;
  /** Rough cost of one Serper search in USD, written to the search log. */
  searchCostUsd: number;
  /**
   * Memory: how old a stored valuation may be and still answer a request. Prices age at different speeds, so there
   * are three limits (see memory.ts::ageClassOf): fast-moving goods (electronics), everything else, slow-moving
   * goods (antiques, art, collectibles). `memoryMaxAgeDays` is the "everything else" limit.
   */
  memoryMaxAgeDays: number;
  memoryFastAgeDays: number;
  memorySlowAgeDays: number;
  /** Memory: minimum confidence of a stored valuation to be trusted as a hit (and to be stored for reuse at all). */
  memoryMinConfidence: number;
  /** Memory: minimum Identification confidence to even look in Memory (and to store a valuation for reuse). */
  memoryMinIdentConfidence: number;
  /** Memory: a valuation is stored for reuse only if at least this many listings were kept as "the same item". */
  memoryMinComps: number;
  /** Memory: widest allowed range (high / low) for a valuation to be reused. A very wide range means "not sure". */
  memoryMaxSpread: number;
  /** Memory: how long to wait for the Detail eye before a Memory look-up is given up (ms after the start). */
  memoryDetailWaitMs: number;
  /**
   * Memory: the Detail eye must be able to read the brand or the model on the item itself. If it cannot, Identification
   * is a lone witness and the Brain runs in full. Turn off only with a measured reason.
   */
  memoryRequireCorroboration: boolean;
  /** Market data link: an ad shows only at or above this match share (0..1), at least `marketMinAds` of them, at most `marketMaxAds`. */
  marketMinMatch: number;
  marketMinAds: number;
  marketMaxAds: number;
  /** Connector AI (see connector.ts) is always on: it changes real searches for a share of valuations; the rest are an unmodified control group. There is no mode switch. */
  /** Connector: share of valuations that may get the change (0..1). The rest are the control group. */
  connectorShare: number;
  /** Connector: the learned dial may never push the treated share below this, so learning can recover. */
  connectorMinShare: number;
  /** Connector: the rules allowed to act. Always all of them (R1, RG, RH). */
  connectorRules: ConnectorRuleId[];
}

/** What is sent to the model: "off" means thinking disabled. */
export type JudgeEffort = "medium" | "high";
/** What JUDGE_EFFORT may say: "auto" (code picks per scan) or one fixed level for every scan. */
export type JudgeEffortSetting = JudgeEffort | "auto";

/** JUDGE_EFFORT: medium or high = fixed for every scan. Anything else (unset, empty, off, low, unknown) = auto: code picks medium or high per scan. */
export function judgeEffortOf(raw: string | undefined): JudgeEffortSetting {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "medium" || v === "high" ? v : "auto";
}

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string, extra?: unknown) => void;
}

function numberIn(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback; // not set: Number("") would be 0
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function nonEmpty(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
}

export function loadConfig(get: (key: string) => string | undefined): BrainConfig {
  const anthropicKey = (get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set");

  return {
    anthropicKey,
    serperKey: nonEmpty(get("SERPER_API_KEY")),
    eyesModel: nonEmpty(get("EYES_MODEL")) ?? "claude-haiku-5-5",
    judgeModel: nonEmpty(get("JUDGE_MODEL")) ?? "claude-haiku-5-5",
    judgeEffort: judgeEffortOf(get("JUDGE_EFFORT")),
    answerMs: Math.floor(numberIn(get("ANSWER_LIMIT_MS"), HARD_CAPS.answerMs, 3000, HARD_CAPS.answerMs)),
    eyesMs: Math.floor(numberIn(get("EYES_WINDOW_MS"), 1500, 500, 3000)),
    searchMs: Math.floor(numberIn(get("SEARCH_WINDOW_MS"), HARD_CAPS.searchMs, 500, HARD_CAPS.searchMs)),
    judgeTargetMs: Math.floor(numberIn(get("JUDGE_TARGET_MS"), 3000, 1500, 4500)),
    fxUrl: nonEmpty(get("FX_URL")),
    searchCostUsd: numberIn(get("SERPER_COST_USD"), 0.001, 0, 1),
    memoryMaxAgeDays: numberIn(get("MEMORY_MAX_AGE_DAYS"), 30, 1, 365),
    memoryFastAgeDays: numberIn(get("MEMORY_FAST_AGE_DAYS"), 10, 1, 365),
    memorySlowAgeDays: numberIn(get("MEMORY_SLOW_AGE_DAYS"), 90, 1, 730),
    memoryMinConfidence: numberIn(get("MEMORY_MIN_CONFIDENCE"), 55, 0, 100),
    memoryMinIdentConfidence: numberIn(get("MEMORY_MIN_IDENT_CONFIDENCE"), 80, 0, 100),
    memoryMinComps: Math.floor(numberIn(get("MEMORY_MIN_COMPS"), 3, 1, 10)),
    memoryMaxSpread: numberIn(get("MEMORY_MAX_SPREAD"), 3, 1.2, 20),
    memoryDetailWaitMs: Math.floor(numberIn(get("MEMORY_DETAIL_WAIT_MS"), 2500, 500, 4000)),
    memoryRequireCorroboration: (get("MEMORY_REQUIRE_CORROBORATION") ?? "").trim().toLowerCase() !== "false",
    marketMinMatch: numberIn(get("MARKET_MIN_MATCH"), 0.8, 0.5, 1),
    marketMinAds: Math.floor(numberIn(get("MARKET_MIN_ADS"), 2, 1, 3)),
    marketMaxAds: Math.floor(numberIn(get("MARKET_MAX_ADS"), 3, 1, 3)),
    connectorShare: numberIn(get("CONNECTOR_SHARE"), 0.5, 0, 1),
    connectorMinShare: numberIn(get("CONNECTOR_MIN_SHARE"), 0.05, 0, 0.5),
    connectorRules: [...CONNECTOR_RULE_IDS],
  };
}
