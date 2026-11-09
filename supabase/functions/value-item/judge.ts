// The Judge: Claude Haiku 5.5, thinking on (adaptive, effort from JUDGE_EFFORT: auto picks medium or high per scan, see pickEffort). It labels, code calculates. It streams its answer so that it can use every millisecond it is
// given, and so that the hard time limit can never be exceeded: when the time is up, whatever
// the Judge has finished writing is used. The most important fields are written first.

import { callClaudeStream, imageBlock, textBlock } from "./claude.ts";
import type { StreamTrace } from "./claude.ts";
import type { BrainConfig, Deps, JudgeEffort, JudgeEffortSetting } from "./config.ts";
import * as C from "./interval.config.ts";
import { ageClassFromEra } from "./anchor.ts";
import { judgeSystemPrompt, judgeUserText } from "./judge-prompt.ts";
import type { FindingStats } from "./judge-prompt.ts";
import { parseTruncatedObject } from "./json.ts";
import { StepError } from "./types.ts";
import type { AuthenticityReport, BrainInput, DetailReport, Finding, Identification, JudgeVerdict } from "./types.ts";
import { validateJudgeLabels } from "./validate.ts";

/** maxTokens when the Judge thinks: room for the thinking plus the JSON answer. */
export const JUDGE_THINKING_MAX_TOKENS = 8000;

// ---------------------------------------------------------------- JUDGE_EFFORT=auto: how hard the Judge thinks, chosen by code

/**
 * Thresholds for pickEffort. Guesses, not measured: check them against steps.judgeTrace (effort, effortReasons, outputTokens) on
 * 20-30 real scans before trusting any saving.
 */
export const EFFORT = {
  /** Identification confidence (0-100) below this counts as "certainty low". */
  identLowConfidence: 60,
  /** A Memory HIT whose saved ads are older than this share of the maximum age is judged hard. */
  memoryAgeShare: 0.5,
  /** Ads conflict when at least this share of them agree with Identification's brand/model AND at least this share do not. */
  conflictShare: 1 / 3,
  conflictMinAds: 3,
} as const;

const HIGH_VALUE_WORDS = /\b(watch|watches|wristwatch|wristwatches|timepiece|jewel+e?ry|jewels|ring|rings|necklace|bracelet|brooch|earrings?|pendant|art|artwork|painting|paintings|sculpture|lithograph|etching|antiques?)\b/;

/** What is already known before the Judge call. Nothing here is fetched: a missing source is simply null. */
export interface EffortSignals {
  /** null = Identification failed or was late. */
  ident: Identification | null;
  /** null = the Authenticity eye failed or was late. */
  authenticity: AuthenticityReport | null;
  findings: readonly Finding[];
  /** The ads come from a Memory HIT, with their age and the maximum age for this kind of item. */
  memoryHit: boolean;
  memoryAgeDays: number | null;
  memoryMaxAgeDays: number | null;
  /** Optional: the Detail eye report (null/missing = not available). */
  details?: DetailReport | null;
}

export interface EffortPick {
  effort: JudgeEffort;
  /** true when code chose it (JUDGE_EFFORT=auto), false for a manual override. */
  auto: boolean;
  /** Why: one code per trigger, or "default_medium" / "manual". Logged in steps.judgeTrace. */
  reasons: string[];
}

function wordsOf(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter((x) => x.length >= 3);
}

/** Do the ads split on Identification's brand or model: a real share name it and a real share do not? Pure. */
export function adsConflict(findings: readonly Finding[], ident: Identification | null): string[] {
  const out: string[] = [];
  if (!ident || findings.length < EFFORT.conflictMinAds) return out;
  const n = findings.length;
  const split = (tokens: string[]): boolean => {
    if (tokens.length === 0) return false;
    const has = findings.filter((f) => { const t = f.title.toLowerCase(); return tokens.some((k) => t.includes(k)); }).length;
    return has / n >= EFFORT.conflictShare && (n - has) / n >= EFFORT.conflictShare;
  };
  if (split(wordsOf(ident.brand))) out.push("brand");
  if (split(wordsOf(ident.model))) out.push("model");
  return out;
}

/**
 * JUDGE_EFFORT=auto: the effort for THIS scan. Pure, no model call, decided before the Judge call from what is already known.
 * Only medium or high. MEDIUM is the default. HIGH only when the item is genuinely hard, i.e. when any of these triggers fires:
 * the Authenticity eye reports medium or high risk; the item is a high-value kind or antique; damage/repair is seen; the eyes struggle on an interesting item;
 * a Memory HIT has old saved ads. Low Identification certainty alone NEVER raises effort (logged as *_ignored).
 * A missing Identification or Authenticity eye, few or no sold ads, conflicting brands or models among the ads, and electronics do NOT raise the effort: missing evidence
 * means time is already short, and few ads make the labelling easier, not harder.
 * A manual setting (medium/high) is returned as is. The Judge itself never receives Identification: these signals only steer how long it thinks.
 */
export function pickEffort(setting: JudgeEffortSetting, s: EffortSignals): EffortPick {
  if (setting !== "auto") return { effort: setting, auto: false, reasons: ["manual"] };
  const reasons: string[] = [];
  const { ident, authenticity: au, findings } = s;

  // Identification unsure: missing information, more thinking cannot create it. Logged only, never raises the effort.
  const ignored: string[] = [];
  if (ident && !ident.identifiable) ignored.push("ident_not_identifiable_ignored");
  else if (ident && !(ident.confidence >= EFFORT.identLowConfidence)) ignored.push("ident_certainty_low_ignored");
  const weakEyes = contradicts(ident, au); // a REAL conflict between the eyes; low Identification certainty never counts

  // Authenticity eye
  if (au && (au.risk_hint === "medium" || au.risk_hint === "high")) reasons.push(`authenticity_risk_${au.risk_hint}`);

  // High-value kinds of item
  if (ident) {
    const cat = ident.category.toLowerCase().trim();
    const antique = ident.age_class === "antique" || ageClassFromEra(eraOf(au, ident)) === "antique";
    if (HIGH_VALUE_WORDS.test(cat) || antique) reasons.push("high_value_category");
  }

  // Damage / repair: same checks as memory.ts storableReason (repair, inconsistency/mismatched part) plus a poor/fair Detail grade with damage text.
  const grade = s.details?.condition?.grade;
  const damageNote = (s.details?.details ?? []).some((n) => n.kind === "damage" && n.text.trim().length > 0);
  const damaged = (grade === "poor" || grade === "fair") && (damageNote || /\b(damage|damaged|crack|cracked|chip|chipped|broken|repair|repaired|restor|missing|stain|rust|tear|torn)/i.test(`${s.details?.condition?.details ?? ""} ${(s.details?.authenticity_signals ?? []).join(" ")}`));
  if (au && au.signs.some((x) => x.kind === "repair" || x.kind === "inconsistency") || damaged) reasons.push("high_damage_or_repair");

  // Eyes struggle on an interesting item: (a) weak/disagreeing eyes AND (b) something unusual or valuable.
  if (weakEyes) {
    const unusual = !!au && (au.rarity_hint === "rare" || au.rarity_hint === "very_rare" || au.signs.some((x) => x.kind === "rarity" || x.kind === "construction" || x.kind === "originality")
      || /\b(handmade|hand-made|signed|limited|unusual)\b/i.test(au.signs.map((x) => x.text).join(" ")));
    const antique = !!ident && (ident.age_class === "antique" || ageClassFromEra(eraOf(au, ident)) === "antique");
    const highValue = !!ident && HIGH_VALUE_WORDS.test(ident.category.toLowerCase().trim());
    const unresolvedMarks = !!ident && !ident.brand && !ident.model && (s.details?.details ?? []).some((n) => (n.kind === "stamp" || n.kind === "serial" || n.kind === "label") && n.text.trim().length > 0);
    if (unusual || antique || highValue || unresolvedMarks) reasons.push("eyes_conflict_interesting");
  }

  // Memory HIT with older saved ads
  if (s.memoryHit && s.memoryAgeDays !== null && s.memoryMaxAgeDays !== null && s.memoryAgeDays > s.memoryMaxAgeDays * EFFORT.memoryAgeShare) reasons.push("memory_hit_old");

  // Conflicting brands or models among the ads no longer raises the effort (it fired on almost every book and ran the Judge out of time).

  if (reasons.length === 0) return { effort: "medium", auto: true, reasons: ["default_medium", ...ignored] };
  return { effort: "high", auto: true, reasons: [...reasons, ...ignored] };
}

/** Ident era contradicts the Authenticity eye's era (different decade / century digits). */
function contradicts(ident: Identification | null, au: AuthenticityReport | null): boolean {
  const a = ident?.era?.match(/\d{3,4}/)?.[0], b = au?.era?.match(/\d{3,4}/)?.[0];
  if (!a || !b) return false;
  return Math.abs(parseInt(a.slice(0, 3), 10) - parseInt(b.slice(0, 3), 10)) >= 2;
}

function eraOf(au: AuthenticityReport | null, ident: Identification | null): string | null {
  return au?.era ?? ident?.era ?? null;
}

export interface JudgeOutcome {
  verdict: JudgeVerdict;
  /** true when the time ran out before the Judge had written everything. */
  partial: boolean;
  ms: number;
  /** For the run log only: how the streamed call went (did it finish, how many tokens, when did the writing start). */
  trace?: StreamTrace & { complete: boolean; stopReason: string | null; outputTokens: number | null };
}

/** What a cut-off answer may borrow, and only from code that has already run (never invented). */
export function fillMissing(v: JudgeVerdict, ident: Identification | null, details: DetailReport | null): JudgeVerdict {
  const missing = new Set(v.missing ?? []);
  const out = { ...v };
  if (missing.has("display_name") && ident) out.display_name = ident.display_name;
  if (missing.has("category") && ident) out.category = ident.category;
  if (!out.brand && ident) out.brand = ident.brand;
  if (!out.model && ident) out.model = ident.model;
  if (missing.has("condition") && details) out.condition = details.condition;
  return out;
}

export async function judge(
  deps: Deps,
  cfg: BrainConfig,
  input: BrainInput,
  ident: Identification | null,
  details: DetailReport | null,
  findings: Finding[],
  stats: FindingStats,
  timeoutMs: number,
  /** Set when the ads are saved ads from Memory (not searched today): their age in days. */
  memoryAgeDays: number | null = null,
  /** Authenticity eye. Optional: a late or failed eye is simply missing. */
  authenticity: AuthenticityReport | null = null,
  /** The effort for this call (pickEffort). Missing: the configured level, and "high" when the setting is "auto" (the safe, old default). */
  effortIn?: JudgeEffort,
): Promise<JudgeOutcome> {
  const started = deps.now();
  const effort: JudgeEffort = effortIn ?? (cfg.judgeEffort === "auto" ? "high" : cfg.judgeEffort);
  const reply = await callClaudeStream(deps, cfg, {
    model: cfg.judgeModel, // Claude Haiku 5.5
    system: judgeSystemPrompt(input, stats, memoryAgeDays),
    // Input 1: the full photo, direct. Nothing in between.
    content: [imageBlock(input.imageMediaType, input.imageBase64), textBlock(judgeUserText(details, findings, memoryAgeDays !== null, authenticity))],
    // The Judge's labels drive all the maths, so it THINKS first (adaptive thinking, steered by effort; Haiku 5.5 takes no
    // token budget). Thinking tokens count toward maxTokens, so the cap leaves room for thinking AND the JSON (about 1300).
    // The Judge only ever runs at medium or high effort (thinking is never off).
    maxTokens: JUDGE_THINKING_MAX_TOKENS,
    // TEMPORARY: thinking is OFF. In production logs the Judge thought for the whole window and wrote nothing (judge failed 6 of 6).
    thinking: { type: "disabled" },
    timeoutMs,
    retries: 0,
  });

  deps.log("[Judge] raw", { effort, stopReason: reply.stopReason, complete: reply.complete, outputTokens: reply.outputTokens, textChars: reply.text.length, preview: reply.text.slice(0, 600), trace: reply.trace });
  const trace = { complete: reply.complete, stopReason: reply.stopReason, outputTokens: reply.outputTokens, thinkingStartMs: reply.trace?.thinkingStartMs ?? null, thinkingEndMs: reply.trace?.thinkingEndMs ?? null, thinkingChars: reply.trace?.thinkingChars ?? 0, firstTextMs: reply.trace?.firstTextMs ?? null };
  const obj = parseTruncatedObject(reply.text);
  if (!obj) throw new StepError("judge", reply.complete ? "no JSON in the answer" : "cut off before any field was finished");

  // A finished answer must be fully valid. A cut-off one is accepted when identity and the labels so far are readable.
  if (reply.complete) {
    const strict = validateJudgeLabels(obj, findings.length);
    if (strict.ok) return { verdict: strict.value, partial: false, ms: deps.now() - started, trace };
  }
  const lenient = validateJudgeLabels(obj, findings.length, true);
  if (!lenient.ok) throw new StepError("judge", "answer failed validation", lenient.errors);
  return { verdict: fillMissing(lenient.value, ident, details), partial: true, ms: deps.now() - started, trace };
}
