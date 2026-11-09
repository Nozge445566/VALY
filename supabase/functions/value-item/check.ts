// "Check and exchange rates: code. No AI. Authenticity flag, plausible figures, currency."
//
// Inputs: the Judge (after a Memory MISS) or Memory (after a HIT). The currency part is in
// localize.ts and runs after this check, every time an answer leaves the server.

import { T, labelsOf } from "./lang.ts";
import type { Lang } from "./lang.ts";
import { MAX_PRICE } from "./validate.ts";
import { confidenceLabel, quantile } from "./numbers.ts";
import type { AuthenticityFlag, BrainResult, FactorLine, PriceRange, Risk } from "./types.ts";

export interface Evidence {
  /** Sold prices (USD) the Judge kept as "same item". */
  keptSoldUsd: number[];
  /** Asking prices (USD) the Judge kept as "same item". */
  keptAskingUsd: number[];
  /** Titles of kept findings, scanned for replica words. */
  keptTitles: string[];
  /** false when no Judge answered or the answer came from Memory. */
  judgeRan: boolean;
  /** true for a Memory hit: the evidence-based caps were applied when it was first valued. */
  fromMemory: boolean;
  /** New item in new condition: shop prices are the real price (askingToSold 1.0) and kept asking prices count as sold-equivalent for the confidence cap. Absent = resale, unchanged. */
  newItem?: boolean;
}

export const EMPTY_EVIDENCE: Evidence = { keptSoldUsd: [], keptAskingUsd: [], keptTitles: [], judgeRan: false, fromMemory: false };

const REPLICA_WORDS = /\b(replica|replika|fake|reproduction|counterfeit|knock-?off|copy of|inspired by|unauthori[sz]ed|1:1|aaa\+?)\b/i;

/** Asking prices are usually above what things sell for. A rule of thumb, not measured data. */
export const ASKING_TO_SOLD = 0.9;

export function authenticityFlagOf(risk: Risk, keptTitles: string[]): AuthenticityFlag {
  const replicaWords = keptTitles.some((t) => REPLICA_WORDS.test(t));
  if (risk === "high") return "high";
  if (risk === "medium" || replicaWords) return "check";
  return "none";
}

export interface FigureCheck {
  range: PriceRange;
  /** A short sentence when the figures were changed, otherwise null. */
  adjusted: string | null;
  /** True when the range is very wide. */
  wide: boolean;
}

/** Makes the figures plausible: ordered, positive, not falsely precise, and in line with sold prices. */
export function checkFigures(input: PriceRange, ev: Evidence, intervalBuilt = false): FigureCheck {
  const vals = [input.low, input.mid, input.high].map((v) => (Number.isFinite(v) ? Math.min(MAX_PRICE, Math.max(0, v)) : 0));
  vals.sort((a, b) => a - b);
  let [low, mid, high] = vals;
  if (!(mid > 0)) return { range: { low: 0, mid: 0, high: 0 }, adjusted: null, wide: false };
  if (!(low > 0)) low = mid * 0.5;
  if (!(high > 0)) high = mid * 1.5;

  let adjusted: string | null = null;

  // The interval engine already weighed the evidence against the model and floors the width
  // itself. Only order and positivity are checked here, so the engine's numbers stay as they are.
  if (intervalBuilt) return { range: { low, mid, high }, adjusted: null, wide: high / low > 12 };

  // Plausible against evidence: three or more kept prices make a band the middle should sit in.
  const soldN = ev.keptSoldUsd.length;
  const evidence =
    soldN >= 3
      ? ev.keptSoldUsd
      : soldN + ev.keptAskingUsd.length >= 3
        ? [...ev.keptSoldUsd, ...ev.keptAskingUsd.map((v) => v * (ev.newItem ? 1 : ASKING_TO_SOLD))]
        : [];
  if (evidence.length >= 3) {
    const bandLow = quantile(evidence, 0.25) * 0.7;
    const bandHigh = quantile(evidence, 0.75) * 1.3;
    let target = mid;
    if (mid < bandLow) target = bandLow;
    else if (mid > bandHigh) target = bandHigh;
    if (target !== mid) {
      const k = target / mid;
      low *= k;
      mid = target;
      high *= k;
      adjusted = "The estimate was moved closer to what comparable items actually sold for.";
    }
  }

  // Too narrow is false precision.
  if (high / low < 1.08) {
    low = mid * 0.94;
    high = mid * 1.06;
  }
  return { range: { low, mid, high }, adjusted, wide: high / low > 12 };
}

/** The most confidence a score may have, given how much real evidence stands behind it. */
export function confidenceCap(ev: Evidence, flag: AuthenticityFlag, wide: boolean): number {
  let cap = 95;
  if (!ev.fromMemory) {
    if (!ev.judgeRan) cap = 35;
    else {
      const n = ev.keptSoldUsd.length + (ev.newItem ? ev.keptAskingUsd.length : 0);
      cap = n >= 5 ? 95 : n >= 3 ? 78 : n >= 1 ? 65 : 50;
    }
  }
  if (flag === "high") cap = Math.min(cap, 55);
  else if (flag === "check") cap = Math.min(cap, 75);
  if (wide) cap = Math.min(cap, 40);
  return cap;
}

/** Applies the whole code check to a result that is still in USD. */
export function checkResult(result: BrainResult, ev: Evidence, flagFromJudge: Risk, intervalBuilt = false, lang?: Lang): BrainResult {
  const t = T(lang);
  if (result.status !== "ok") return result;
  const figs = checkFigures({ low: result.low, mid: result.mid, high: result.high }, ev, intervalBuilt);
  const flag = authenticityFlagOf(flagFromJudge, ev.keptTitles);
  const cap = confidenceCap(ev, flag, figs.wide);

  let score = Math.min(result.confidenceScore, cap);
  if (figs.adjusted) score = Math.max(5, score - 10);

  const authLabels = labelsOf("authenticity");
  const factors: FactorLine[] = result.factors.filter((f) => !authLabels.includes(f.label));
  if (flag === "high" || flag === "check") {
    factors.push({
      label: t.labels.authenticity,
      detail:
        flag === "high"
          ? t.authHigh
          : t.authCheck,
    });
  }
  if (figs.adjusted) factors.push({ label: t.labels.checked, detail: lang === "sv" ? t.movedCloser : figs.adjusted });
  if (figs.wide) factors.push({ label: t.labels.checked, detail: t.veryWide });

  return {
    ...result,
    low: figs.range.low,
    mid: figs.range.mid,
    high: figs.range.high,
    confidenceScore: Math.round(Math.max(5, score)),
    confidence: confidenceLabel(Math.round(Math.max(5, score))),
    authenticityFlag: flag,
    factors,
  };
}
