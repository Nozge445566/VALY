// JudgeReport v2 schema. The Judge answers with BANDS only; code maps bands to numbers in
// ad-calibration.ts. Everything here is pure and total: unreadable or contradictory values become undefined, never a guess.
import type { PSameBand, Reliability, RelativeBand } from "./ad-calibration.ts";
import { P_SAME_SE2, RELIABILITY_SE2, RELATIVE_BANDS } from "./ad-calibration.ts";

export const P_SAME_BANDS = Object.keys(P_SAME_SE2) as PSameBand[];
export const RELIABILITY_BANDS = Object.keys(RELIABILITY_SE2) as Reliability[];
export type IdentityCertainty = "high" | "medium" | "low";
export const IDENTITY_CERTAINTIES: IdentityCertainty[] = ["high", "medium", "low"];
export const MAX_VARIANT_DIFFS = 3;

/** The per-ad part of the JSON schema text shown to the Judge. ONE source for prompt text and validator. */
export const AD_FIELDS_TEXT = `{ "id": number, "match": "same" | "similar" | "different", "p_same": "${P_SAME_BANDS.filter((b) => b !== "no").join('" | "')}", "variant_diffs": [ string ], "ad_reliability": "${RELIABILITY_BANDS.join('" | "')}", "relative_value": "${RELATIVE_BANDS.join('" | "')}" }`;


/**
 * Compact ad line (what the Judge now writes per ad): "id|match|p_same|ad_reliability|relative_value|variant_diffs".
 * Same bands as AD_FIELDS_TEXT, same words (no renaming, so ad-calibration.ts and stored data are untouched), but no JSON keys:
 * far fewer tokens to write. Empty field = not given (stays undefined, never guessed). variant_diffs are separated by ";".
 */
export const AD_COMPACT_TEXT = `"<id>|<match>|<p_same>|<ad_reliability>|<relative_value>|<variant_diffs>"`;

/**
 * Expands one compact ad line into the SAME record shape the old per-ad JSON object had, so validateJudgeLabels reads both
 * through one path. Pure and total: an unreadable line is null (the ad is dropped, as an unreadable object is today). A field
 * that is empty is simply left out: nothing is ever filled in for the Judge.
 */
export function expandCompactAd(line: string): Record<string, unknown> | null {
  if (typeof line !== "string") return null;
  const parts = line.split("|");
  if (parts.length < 2) return null;
  const id = parts[0].trim();
  if (!/^\d{1,4}$/.test(id)) return null;
  const out: Record<string, unknown> = { id: Number(id), match: parts[1].trim() };
  const put = (key: string, v: string | undefined) => { const t = (v ?? "").trim(); if (t) out[key] = t; };
  put("p_same", parts[2]);
  put("ad_reliability", parts[3]);
  put("relative_value", parts[4]);
  const diffs = parts.slice(5).join("|").split(";").map((x) => x.trim()).filter((x) => x.length > 0);
  if (diffs.length > 0) out["variant_diffs"] = diffs;
  return out;
}

const norm = (x: unknown) => (typeof x === "string" ? x.trim().toLowerCase().replace(/[\s_-]+/g, "") : "");

export function readPSame(x: unknown): PSameBand | undefined {
  const v = norm(x);
  return (P_SAME_BANDS as string[]).includes(v) ? (v as PSameBand) : undefined;
}
export function readReliability(x: unknown): Reliability | undefined {
  const v = norm(x);
  return (RELIABILITY_BANDS as string[]).includes(v) ? (v as Reliability) : undefined;
}
/** relative_value band ("Much worse", "much-worse" and "MUCH_WORSE" all read). Anything else is undefined, never guessed. */
export function readRelative(x: unknown): RelativeBand | undefined {
  if (typeof x !== "string") return undefined;
  const v = x.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (RELATIVE_BANDS as readonly string[]).includes(v) ? (v as RelativeBand) : undefined;
}
export function readIdentityCertainty(x: unknown): IdentityCertainty | undefined {
  const v = norm(x);
  return (IDENTITY_CERTAINTIES as string[]).includes(v) ? (v as IdentityCertainty) : undefined;
}
/** Short differences the Judge sees between the item and this ad (size, edition...). Text is data: trimmed, bounded, never executed. */
export function readVariantDiffs(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const s of x) {
    if (typeof s !== "string") continue;
    const t = s.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60);
    if (t) out.push(t);
    if (out.length >= MAX_VARIANT_DIFFS) break;
  }
  return out;
}

/**
 * A band must agree with the coarse label, otherwise the band is ignored (the coarse label then decides):
 * "same" with p_same unlikely/no, "similar" with p_same certain, and any band on a "different" ad are contradictions.
 */
export function consistentPSame(match: "same" | "similar" | "different", p: PSameBand | undefined): PSameBand | undefined {
  if (!p || match === "different") return undefined;
  if (match === "same" && (p === "unlikely" || p === "no")) return undefined;
  if (match === "similar" && p === "certain") return undefined;
  return p;
}

/** Share of ads with a stated variant difference: a signal for variantAmbiguity (shared bias does not shrink with more ads). */
export function variantDiffShare(ads: { variant_diffs?: string[] }[]): number | null {
  if (ads.length === 0) return null;
  return ads.filter((a) => (a.variant_diffs?.length ?? 0) > 0).length / ads.length;
}
