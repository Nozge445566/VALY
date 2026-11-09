// Which found listings are even about the item. Pure, no network, microseconds.
//
// Market Live reads plain Google web results and takes the first price in the title or snippet. Many hits are category pages,
// blogs or other products. The ad selector (select-ads.ts) picks ads by PRICE statistics only, so an off-topic page with a
// "typical" price could take a Judge slot. This filter runs first and removes hits that share too little with what we searched for.
// The searches are written in the user's market language by Identification, so this works in every language.

import type { Finding } from "./types.ts";

type Ad = Omit<Finding, "id">;

/** Words that carry no product meaning in a search (sold, price, used ... in the main market languages). */
const STOP = new Set([
  "sold", "såld", "sålda", "såldt", "solgt", "myyty", "verkauft", "vendu", "vendido", "venduto", "verkocht", "sprzedane",
  "price", "pris", "prix", "preis", "precio", "prezzo", "prijs", "used", "begagnad", "gebraucht", "occasion", "usado", "usato",
  "köp", "kop", "buy", "for", "the", "and", "och", "med", "till", "von", "und", "der", "die", "das", "les", "des", "del", "con",
  "ebay", "blocket", "tradera", "vinted", "facebook", "marketplace", "olx", "finn", "dba",
]);

export const tokensOf = (text: string): string[] =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** Share (0..1) of the query's content words that the listing text contains. A word counts if one contains the other (plurals, compounds: "badrumsvåg" / "badrumsvågar"). */
export function queryCoverage(adText: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const ad = tokensOf(adText);
  let hit = 0;
  for (const q of queryTokens) if (ad.some((a) => a === q || (q.length >= 4 && a.length >= 4 && (a.includes(q) || q.includes(a))))) hit++;
  return hit / queryTokens.length;
}

/** Best coverage of one listing over all the searches that were run. */
export function relevanceOf(ad: Pick<Ad, "title" | "snippet">, queries: readonly string[]): number {
  const text = `${ad.title} ${ad.snippet ?? ""}`;
  let best = 0;
  for (const q of queries) best = Math.max(best, queryCoverage(text, tokensOf(q)));
  return best;
}

/** A listing must match at least this share of at least one search's words. */
export const MIN_RELEVANCE = 0.5;
/** Fewer than this many survivors: the filter is not trusted and everything is kept (it must never make an answer worse by emptying it). */
export const MIN_KEEP = 3;

export function keepRelevant<T extends Pick<Ad, "title" | "snippet">>(ads: T[], queries: readonly string[]): { kept: T[]; removed: number } {
  if (queries.length === 0 || ads.length === 0) return { kept: ads, removed: 0 };
  const kept = ads.filter((a) => relevanceOf(a, queries) >= MIN_RELEVANCE);
  if (kept.length < MIN_KEEP) return { kept: ads, removed: 0 };
  return { kept, removed: ads.length - kept.length };
}
