// Turns the findings into short, honest sentences for the app.
// These texts contain no money amounts, so they stay correct in every currency.

import { T } from "./lang.ts";
import type { AuthenticityReport } from "./types.ts";
import type { Lang } from "./lang.ts";
import type { DetailReport, FactorLine, Finding, Grade, JudgeVerdict } from "./types.ts";

function gradeLabel(g: Grade, lang?: Lang): string {
  return T(lang).grade[g] ?? g;
}

/** "memory" = the listings were not searched today: they are the saved ones from an earlier valuation (see memory.ts). */
export type MarketState = "ok" | "thin" | "empty" | "failed" | "disabled" | "memory";

export interface FactorArgs {
  verdict: JudgeVerdict;
  details: DetailReport | null;
  findings: Finding[];
  marketState: MarketState;
  soldTarget: number;
  needsMoreInfo: string | null;
  /** Language of the sentences. Missing = English. */
  lang?: Lang;
  /** Age in days of the saved listings when marketState is "memory". */
  memoryAgeDays?: number;
  /** Authenticity eye output (construction signs, era). Shown as one line when it reported something. */
  authenticity?: AuthenticityReport | null;
}

/**
 * The "Condition" and "Details" lines written from what the Detail eye sees in THIS photo. A Memory answer shows
 * these instead of the stored lines, so the person reads what was just looked at, not what was seen last time.
 */
export function freshDetailFactors(details: DetailReport, lang?: Lang): FactorLine[] {
  const t = T(lang);
  const out: FactorLine[] = [
    { label: t.labels.condition, detail: `${gradeLabel(details.condition.grade, lang)}. ${details.condition.details}`.trim() },
  ];
  const seen = details.details.filter((d) => d.kind !== "damage").slice(0, 3);
  if (seen.length > 0) out.push({ label: t.labels.details, detail: seen.map((d) => d.text.replace(/\.$/, "")).join("; ") + "." });
  return out;
}

export function buildFactors(a: FactorArgs): FactorLine[] {
  const v = a.verdict;
  const t = T(a.lang);
  const out: FactorLine[] = [];

  const maker = v.brand ? t.likely(v.brand, v.model ?? null) : "";
  out.push({ label: t.labels.item, detail: `${v.display_name.replace(/\.$/, "")}.${maker}` });
  out.push({ label: t.labels.condition, detail: `${gradeLabel(v.condition.grade, a.lang)}. ${v.condition.details}`.trim() });

  const seen = a.details?.details.filter((d) => d.kind !== "damage").slice(0, 3) ?? [];
  if (seen.length > 0) {
    out.push({ label: t.labels.details, detail: seen.map((d) => d.text.replace(/\.$/, "")).join("; ") + "." });
  }

  const sameIds = new Set(v.same);
  const kept = a.findings.filter((f) => sameIds.has(f.id));
  const keptSold = kept.filter((f) => f.kind === "sold").length;
  if (a.marketState === "ok" || a.marketState === "thin") {
    const sites = Array.from(new Set(kept.map((f) => f.site))).slice(0, 3).join(", ");
    out.push({
      label: t.labels.market,
      detail: t.market.matched(kept.length, a.findings.length, keptSold, sites) +
        (keptSold < a.soldTarget ? t.market.fewerSold(a.soldTarget) : ""),
    });
  } else if (a.marketState === "memory") {
    out.push({ label: t.labels.market, detail: t.market.fromMemory(kept.length, Math.round(a.memoryAgeDays ?? 0)) });
  } else if (a.marketState === "empty") {
    out.push({ label: t.labels.market, detail: t.market.empty });
  } else if (a.marketState === "disabled") {
    out.push({ label: t.labels.market, detail: t.market.disabled });
  } else {
    out.push({ label: t.labels.market, detail: t.market.failed });
  }

  const au = a.authenticity;
  if (au) {
    const signs = au.signs.slice(0, 3).map((m) => m.text.replace(/\.$/, "")).filter((x) => x.length > 0);
    const parts = [...signs, ...(au.era ? [au.era] : [])];
    if (parts.length > 0) out.push({ label: t.labels.construction, detail: parts.join("; ") + "." });
  }
  const mism = (v.eye_text_mismatch ?? []).slice(0, 2).map((x) => String(x).replace(/\.$/, "")).filter((x) => x.length > 0);
  if (mism.length > 0) out.push({ label: t.labels.textCheck, detail: mism.join("; ") + "." });

  if (v.reason) out.push({ label: t.labels.why, detail: v.reason.replace(/\.$/, "") + "." });
  if (v.unknowns.length > 0) out.push({ label: t.labels.uncertain, detail: v.unknowns.slice(0, 2).join("; ") + "." });
  if (a.needsMoreInfo) out.push({ label: t.labels.improve, detail: a.needsMoreInfo });
  return out;
}
