// The logic behind the one small link on the result page ("Se marknadsdata" / "Se hur vi värderade"). Pure: no React, no network.
//
// The server decides which ads qualify (match >= MARKET_MIN_MATCH, at least MARKET_MIN_ADS, at most 3) and sends them as `marketAds`.
// The app only follows: enough ads -> "market", otherwise -> "explain". Never both. The kind never flips later (a dead link is
// replaced by the source's search page, it does not change which link the person sees).
//
// Rights: title, price and image of an ad are shown only for a source that allows it (SOURCE_RIGHTS). Nothing is scraped or hosted.
// Without rights a row is a plain link with the source's name. Add a source to SOURCE_RIGHTS only when it has an official API,
// partner programme or terms that allow it, and only to the extent they allow.

export type InsightKind = "market" | "explain";

export interface AdLike {
  title: string;
  url: string;
  price: number;
  /** Only when a permitted source supplies an image URL. The valuation engine sends none today. */
  image?: string;
}

export interface MarketRow {
  href: string;
  /** The source's name ("Tradera"). */
  source: string;
  /** The ad's title, only when the source allows showing it. */
  title: string | null;
  /** Formatted price, only when the source allows showing it. */
  price: string | null;
  /** Only when the source allows it. A row without one has no image box at all. */
  image: string | null;
  kind: "ad" | "search";
}

interface Rights {
  title: boolean;
  price: boolean;
  image: boolean;
}

const NONE: Rights = { title: false, price: false, image: false };

/**
 * Per source id (see sourceOf). Empty on purpose: no source has been confirmed yet (open decision 3 in the spec).
 * Example once Tradera's terms or API allow it: `tradera: { title: true, price: true, image: false }`.
 */
export const SOURCE_RIGHTS: Record<string, Rights> = {};

interface Source {
  id: string;
  name: string;
  /** Search page with the item's name filled in. */
  search: (q: string) => string;
}

const KNOWN: Source[] = [
  { id: "tradera", name: "Tradera", search: (q) => `https://www.tradera.com/search?q=${encodeURIComponent(q)}` },
  { id: "blocket", name: "Blocket", search: (q) => `https://www.blocket.se/annonser/hela_sverige?q=${encodeURIComponent(q)}` },
  { id: "ebay", name: "eBay", search: (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}` },
];

/** The site's id and display name from a link. Unknown sites get their domain name, capitalised. Null for a link that is not http(s). */
export function sourceOf(url: string): { id: string; name: string; known: Source | null } | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  const known = KNOWN.find((s) => host === `${s.id}.com` || host === `${s.id}.se` || host.endsWith(`.${s.id}.com`) || host.endsWith(`.${s.id}.se`) || host.startsWith(`${s.id}.`)) ?? null;
  if (known) return { id: known.id, name: known.name, known };
  const label = host.split(".").slice(-2, -1)[0] ?? host;
  return { id: label, name: label.charAt(0).toUpperCase() + label.slice(1), known: null };
}

/** One row per known site, linking to its search page for the item. No image, no price. */
export function searchRows(itemName: string): MarketRow[] {
  return KNOWN.map((s) => ({ href: s.search(itemName), source: s.name, title: null, price: null, image: null, kind: "search" as const }));
}

/** Which link the result page shows. Decided only by what the server sent. */
export function insightKind(r: { marketAds?: readonly unknown[]; minAds?: number }): InsightKind {
  const min = typeof r.minAds === "number" && r.minAds >= 1 ? r.minAds : 2;
  return (r.marketAds?.length ?? 0) >= min ? "market" : "explain";
}

/**
 * The rows of the market box: at most three, one per ad. A dead link becomes the source's search page (or is dropped when the
 * source has none); duplicates are removed. When nothing usable is left the fallback is one search row per site.
 */
export function marketRows(
  ads: readonly AdLike[],
  itemName: string,
  opts: { dead?: ReadonlySet<string>; formatPrice: (n: number) => string; max?: number },
): MarketRow[] {
  const max = opts.max ?? 3;
  const rows: MarketRow[] = [];
  const seen = new Set<string>();
  const push = (row: MarketRow) => {
    if (rows.length < max && !seen.has(row.href)) {
      seen.add(row.href);
      rows.push(row);
    }
  };
  for (const ad of ads) {
    const src = sourceOf(ad.url);
    if (!src) continue;
    if (opts.dead?.has(ad.url)) {
      if (src.known) push({ href: src.known.search(itemName), source: src.name, title: null, price: null, image: null, kind: "search" });
      continue;
    }
    const rights = SOURCE_RIGHTS[src.id] ?? NONE;
    const image = rights.image && ad.image && /^https:\/\//i.test(ad.image) ? ad.image : null;
    push({
      href: ad.url,
      source: src.name,
      title: rights.title && ad.title.trim() ? ad.title.trim() : null,
      price: rights.price && ad.price > 0 ? opts.formatPrice(ad.price) : null,
      image,
      kind: "ad",
    });
  }
  return rows.length > 0 ? rows : searchRows(itemName).slice(0, max);
}

/** The small text under a row's title: "Tradera · 420 kr". Without rights it is empty (the title line already says the source). */
export function rowSubline(row: MarketRow): string | null {
  if (row.kind === "search") return null;
  if (row.title) return row.price ? `${row.source} · ${row.price}` : row.source;
  return row.price;
}

/** What the row's title line says: the ad's title when allowed, otherwise the source's name. */
export function rowTitle(row: MarketRow): string {
  return row.title ?? row.source;
}

/** The currency's short symbol in the person's language ("kr", "$", "€"), or its code. Used as the unit in the written explanation. */
export function currencyUnit(code: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: "currency", currency: code, maximumFractionDigits: 0 }).formatToParts(1).find((p) => p.type === "currency");
    return part?.value.trim() || code;
  } catch {
    return code;
  }
}

export interface ExplainSource {
  itemName: string;
  currency: string;
  low: number;
  mid: number;
  high: number;
  conditionLabel: string | null;
  comparableCount: number;
  explain?: { era: string | null; origin: string | null; material: string | null; identConfidence: number | null; highValueOrAntique: boolean } | null;
}

/** The facts sent to the writer. Unknown stays null (the writer must not mention it). Never invents a field. */
export function buildExplainInput(r: ExplainSource, locale: string) {
  const e = r.explain ?? null;
  const when = [e?.origin, e?.era].filter((x): x is string => !!x).join(", ");
  const basis = ["en uppskattning utifrån föremålets typ, material, skick och ålder"];
  if (r.comparableCount > 0) basis.push("några annonser som liknar föremålet, men ingen matchade tillräckligt säkert för att räknas som marknadsdata");
  return {
    foremal: r.itemName,
    identifiering_sakerhet: e?.identConfidence != null ? Math.round(e.identConfidence) / 100 : null,
    tid_ursprung: when || null,
    material: e?.material ?? null,
    skick: r.conditionLabel,
    marknadsdata_finns: false,
    underlag_for_pris: basis,
    varde: r.mid,
    intervall: [r.low, r.high] as [number, number],
    valuta: currencyUnit(r.currency, locale),
    hogt_varde_eller_antikt: e?.highValueOrAntique === true,
  };
}
