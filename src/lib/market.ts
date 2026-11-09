// Which market a valuation belongs to, and how to say so quietly. One place, no UI.
//
// The valuation engine sends `market` (the user's country and where the evidence came from) and, per comparable,
// `origin` (country of the listing) and `tier` (local / regional / global). Nothing here changes a
// price: money is converted by the valuation engine. This file only helps the screens avoid showing a price or a
// listing from another market as if it were local.

import { FOREIGN_DATA_NOTE, textsFor } from "./texts.ts";
import { currentLang, langOfLocale, type Lang } from "./i18n.ts";

export type Tier = "local" | "regional" | "global";
export type Basis = Tier | "none";

export interface MarketInfo {
  /** ISO alpha-2 of the market the price was made for. "ZZ" means the valuation engine did not know. */
  country: string;
  basis: Basis;
  local: number;
  regional: number;
  global: number;
  /** True when a learned price-level shift moved the foreign prices toward the user's own level. */
  adjusted: boolean;
}

const COUNTRY = /^[A-Z]{2}$/;

/** A clean country code or null. "ZZ" (unknown) and anything malformed give null. */
export function cleanCountry(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return COUNTRY.test(c) && c !== "ZZ" ? c : null;
}

export function readTier(v: unknown): Tier | undefined {
  return v === "local" || v === "regional" || v === "global" ? v : undefined;
}

/** Reads `result.market`. Old results have none: null (treated as unknown, never as an error). */
export function readMarket(v: unknown): MarketInfo | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  const basis: Basis = m.basis === "local" || m.basis === "regional" || m.basis === "global" ? m.basis : "none";
  const country = typeof m.country === "string" && COUNTRY.test(m.country.trim().toUpperCase())
    ? m.country.trim().toUpperCase()
    : "ZZ";
  return { country, basis, local: n(m.local), regional: n(m.regional), global: n(m.global), adjusted: m.adjusted === true };
}

/** Full country name in the user's language, or the code itself when the browser cannot tell. */
export function countryName(code: string, locale?: string): string {
  try {
    const name = new Intl.DisplayNames(locale ? [locale] : undefined, { type: "region" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/**
 * The small tag on a listing from another country, or null. A listing is foreign when its tier is not
 * local and its country is known. (An unknown market ZZ has no foreign listings: the valuation engine never labels any.)
 */
export function listingTag(c: { origin?: string; tier?: Tier }): string | null {
  if (!c.tier || c.tier === "local") return null;
  return cleanCountry(c.origin);
}

/** The countries behind the listings from another country, most listings first, at most `max` (default 2). */
export function foreignOrigins(comparables: readonly { origin?: string; tier?: Tier }[], max = 2): string[] {
  const count = new Map<string, number>();
  for (const c of comparables) {
    const tag = listingTag(c);
    if (tag) count.set(tag, (count.get(tag) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([code]) => code);
}

/** "the United States" / "the United States and Germany" / "A, B and C": plain join of country names. */
export function joinNames(names: readonly string[], lang: Lang = currentLang()): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${textsFor(lang).foreignData.and} ${names[names.length - 1]}`;
}

/**
 * The one calm sentence about foreign data, only when the owner switched it on (FOREIGN_DATA_NOTE). It names the
 * countries of the foreign listings that are shown (so a number is never "just wider": the person can see why), and
 * says so when a learned price-level adjustment was applied. Pass the result's comparables and the user's locale.
 */
export function foreignDataSentence(
  market: MarketInfo | null,
  comparables: readonly { origin?: string; tier?: Tier }[] = [],
  locale?: string,
): string | null {
  if (!FOREIGN_DATA_NOTE || !market) return null;
  if (market.basis !== "regional" && market.basis !== "global") return null;
  // The language follows the locale given (the app passes uiLocale()); without one, the phone's language.
  const lang = locale === undefined ? currentLang() : langOfLocale(locale);
  const T = textsFor(lang).foreignData;
  const names = foreignOrigins(comparables).map((c) => countryName(c, locale));
  const where = names.length
    ? joinNames(names, lang)
    : market.basis === "regional" ? T.genericRegional : T.genericGlobal;
  const base = market.basis === "regional" ? T.regional(where) : T.global(where);
  return market.adjusted ? `${base} ${T.adjusted}` : base;
}

/**
 * History rows: the small chip that says the evidence behind an old valuation was foreign, or null. Only when
 * the owner switched the note on, and only for regional or global evidence (`market_basis` is saved with the row).
 */
export function historyBasisChip(
  basis: string | null | undefined,
  adjusted?: boolean | null,
): { label: string; title: string } | null {
  if (!FOREIGN_DATA_NOTE) return null;
  const TEXTS = textsFor(currentLang());
  // `adjusted` (saved as market_adjusted) is only ever added to the tooltip: the chip itself stays small.
  const more = adjusted === true ? ` ${TEXTS.foreignData.adjusted}` : "";
  if (basis === "regional") return { label: TEXTS.foreignData.nearbyMarkets, title: `${TEXTS.historyBasis.regional}${more}` };
  if (basis === "global") return { label: TEXTS.foreignData.otherMarkets, title: `${TEXTS.historyBasis.global}${more}` };
  return null;
}

/**
 * For history rows: the country to show next to an old valuation, or null when it is the same as the
 * device's own country (nothing to warn about) or unknown. Compare with `detectCurrency().country`.
 */
export function historyCountryTag(rowCountry: string | null | undefined, deviceCountry: string | null): string | null {
  const c = cleanCountry(rowCountry);
  if (!c) return null;
  return c === (deviceCountry ?? "").toUpperCase() ? null : c;
}

/** The columns saved next to a valuation row (see migration 20261101120000_valuations_market.sql). */
export function marketColumns(result: { market: MarketInfo | null; currency: string }): {
  market_country: string | null;
  market_basis: string | null;
  /** TRUE when a learned price-level shift moved the foreign prices (migration 20261103100000). */
  market_adjusted: boolean | null;
  currency: string;
} {
  return {
    market_country: result.market ? result.market.country : null,
    market_basis: result.market ? result.market.basis : null,
    market_adjusted: result.market ? result.market.adjusted === true : null,
    currency: result.currency,
  };
}
