// item fingerprint and context keys.
// A fingerprint holds only facts about the ITEM and its market. Never a photo, a user or an address.
// Python traps handled: \w is Unicode (\p{L}\p{N}_), slicing is by code point, null not undefined.

import type { Fingerprint } from "../../value-item/types.ts";
import { languageOf, regionOf } from "./data.ts";

// Python: re.compile(r"[^\w\s.\-]", re.UNICODE). Python \s also holds \x1c-\x1f and \x85.
const CLEAN = /[^\p{L}\p{N}_\s\x1c-\x1f\x85.\-]/gu;
const WS = /[\s\x1c-\x1f\x85]+/gu;

function slicePoints(s: string, limit: number): string {
  return Array.from(s).slice(0, limit).join("");
}

/** fingerprint.py norm */
export function norm(value: unknown, limit = 80): string {
  if (typeof value !== "string") return "";
  const t = value.toLowerCase().replace(CLEAN, " ").replace(WS, " ").trim();
  return slicePoints(t, limit);
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Python: str(x or default). Falsy values (null, "", 0, false) give the default. */
function strOr(v: unknown, dflt: string): string {
  if (v === null || v === undefined || v === "" || v === 0 || v === false) return dflt;
  return String(v);
}

/** fingerprint.py clean_fingerprint: null if unusable. */
export function cleanFingerprint(raw: unknown): Fingerprint | null {
  if (!isDict(raw)) return null;
  const category = norm(raw.category, 40);
  const type = norm(raw.type, 80) || category;
  if (!category && !type) return null;
  let country = strOr(raw.country, "ZZ").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) country = "ZZ";
  let language = strOr(raw.language, "").toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(language)) language = languageOf(country === "ZZ" ? null : country);
  return {
    category: category || type,
    brand: norm(raw.brand) || null,
    type,
    model: norm(raw.model, 100) || null,
    era: norm(raw.era, 40) || null,
    country,
    language,
    // mode only exists for non-resale items; absent key keeps resale fingerprints byte-identical.
    ...(raw.mode === "retail" || raw.mode === "auction" ? { mode: raw.mode } : {}),
  };
}

/** fingerprint.py context_keys: most general to most specific. */
export function contextKeys(fp: Fingerprint): string[] {
  const cat = fp.category;
  const country = fp.country;
  const brand = fp.brand || "-";
  const keys = ["g"];
  if (country !== "ZZ") {
    const region = regionOf(country);
    if (region) keys.push(`r:${region}`);
    keys.push(`k:${country}`);
  }
  keys.push(`c:${cat}`, `cc:${cat}|${country}`, `cb:${cat}|${brand}|${country}`);
  return keys;
}

/** fingerprint.py item_text */
export function itemText(fp: Fingerprint): string {
  const parts = [fp.brand, fp.model || fp.type].filter((p): p is string => Boolean(p));
  const text = parts.join(" ").trim() || fp.type;
  return slicePoints(text.replace(WS, " "), 80);
}
