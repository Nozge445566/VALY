// thin accessors over the existing TS tables.
// No value is defined here. Everything is re-exported or derived from markets.ts, market-tiers.ts
// and fixed-templates.ts, so there is one source of truth on the TypeScript side.

import { COUNTRY_LANGUAGE, MARKETPLACES, SPECIALISTS } from "../../value-item/markets.ts";
import {
  COUNTRY_STATS_MIN_N,
  DATA_RICH,
  HIGH_SOLD_PER_SEARCH,
  REGION_GROUPS,
  regionalPeers as tiersRegionalPeers,
  SOLD_WORD,
  THIN_BELOW_SOLD_PER_SEARCH,
} from "../../value-item/market-tiers.ts";
import { SOLD_LOCAL } from "../../value-item/fixed-templates.ts";

export { COUNTRY_LANGUAGE, DATA_RICH, MARKETPLACES, REGION_GROUPS, SOLD_LOCAL, SOLD_WORD, SPECIALISTS };

/** data.py language_of */
export function languageOf(country: string | null | undefined): string {
  if (!country) return "en";
  return COUNTRY_LANGUAGE[country.toUpperCase()] ?? "en";
}

/** data.py marketplaces: a copy, [] for an unknown country. */
export function marketplaces(country: string): string[] {
  return [...(MARKETPLACES[country.toUpperCase()] ?? [])];
}

/** data.py specialist_for: first matching specialist site, in table order. */
export function specialistFor(text: string): string | null {
  for (const s of SPECIALISTS) {
    s.match.lastIndex = 0;
    if (s.match.test(text)) return s.site;
  }
  return null;
}

/** data.py sold_local: the word used in the fixed templates. */
export function soldLocal(lang: string): string {
  return SOLD_LOCAL[lang] ?? "sold";
}

/** data.py sold_word: the word used by escalation searches (lang may be "pt-BR"). */
export function soldWord(lang: string): string {
  return SOLD_WORD[lang.toLowerCase().split("-")[0]] ?? "sold";
}

/** data.py region_groups: copies. */
export function regionGroups(): string[][] {
  return REGION_GROUPS.map((g) => [...g]);
}

/** data.py thresholds (same numbers, snake_case keys as in markets.json). */
export function thresholds(): { thin_below_sold_per_search: number; high_sold_per_search: number; country_stats_min_n: number } {
  return {
    thin_below_sold_per_search: THIN_BELOW_SOLD_PER_SEARCH,
    high_sold_per_search: HIGH_SOLD_PER_SEARCH,
    country_stats_min_n: COUNTRY_STATS_MIN_N,
  };
}

/** data.py data_rich: a copy. */
export function dataRich(): Set<string> {
  return new Set(DATA_RICH);
}

/** data.py region_of: lead country of the FIRST group that holds the country, else null. */
export function regionOf(country: string | null | undefined): string | null {
  const c = (country ?? "").toUpperCase();
  if (!c || c === "ZZ") return null;
  for (const g of REGION_GROUPS) if (g.includes(c)) return g[0];
  return null;
}

/** data.py regional_peers. Same rule as regionalPeers in market-tiers.ts (re-checked by the golden test). */
export function regionalPeers(country: string | null | undefined): string[] {
  return tiersRegionalPeers(country ?? null);
}

/** data.py tier_of_gl: local / regional / global for a search aimed at `gl`, seen from `country`. */
export function tierOfGl(gl: string, country: string | null | undefined): "local" | "regional" | "global" {
  const u = (country ?? "").toUpperCase();
  if (!u || u === "ZZ") return "local";
  const o = (gl ?? "").toUpperCase();
  if (o === u) return "local";
  return regionalPeers(u).includes(o) ? "regional" : "global";
}
