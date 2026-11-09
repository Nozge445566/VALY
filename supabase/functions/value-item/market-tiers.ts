// Country adaptation for Market Live: where did a price come from, and how far can it be trusted?
//
// The ladder is  LOCAL (the user's country)  ->  REGIONAL (neighbouring markets)  ->  GLOBAL
// (US / worldwide). Every listing found by Market Live carries the tier it came from. Nothing here
// talks to the network or an AI: it is pure, so it can be tested without any cost.
//
// The maths in one paragraph (all constants live in interval.config.ts):
//   A foreign price is a noisier witness of the price in the user's country. If the noise of a
//   tier is s_t (log units), a listing from that tier is worth  m_t = s0^2 / (s0^2 + s_t^2)  of a
//   local one (inverse-variance weighting, s0 = ordinary listing-to-listing noise). The SAME
//   weight is used for (1) deciding whether enough sold prices were found, (2) weighting the
//   listings inside the interval engine, and (3) the extra uncertainty the engine adds.
//   So the confidence falls smoothly as the evidence gets more foreign: no hand-made steps.
//
// Honest limits: the regions and the "thin data" list are starting values. The nightly learner
// (Part 2) should replace "thin data" with measured sold-prices-per-search for each country.

import { FOREIGN_NOISE_S0, FOREIGN_STD } from "./interval.config.ts";
import type { FallbackLevel } from "./interval.config.ts";
import { COUNTRY_LANGUAGE, MARKETPLACES, languageOf, specialistFor } from "./markets.ts";
import type { Fingerprint, PlannedSearch } from "./types.ts";

export type Tier = FallbackLevel; // "local" | "regional" | "global"

// ---------------------------------------------------------------- regions

/** Groups of neighbouring markets, best market first. A country may be in two groups. */
export const REGION_GROUPS: readonly (readonly string[])[] = [
  ["SE", "NO", "DK", "FI", "IS"],
  ["DE", "AT", "CH", "NL", "BE", "LU"],
  ["FR", "BE", "LU", "ES", "IT", "PT"],
  ["IT", "ES", "PT", "FR"],
  ["GB", "IE"],
  ["PL", "CZ", "HU", "RO", "GR", "TR", "UA"],
  ["US", "CA"],
  ["CA", "US"],
  ["AU", "NZ"],
  ["JP", "KR", "TW", "HK", "CN"],
  ["SG", "MY", "TH", "ID", "VN", "PH", "HK"],
  ["BR", "MX", "AR", "CL", "CO"],
  ["MX", "US", "CA"],
  ["AE", "SA", "IL"],
  ["IN", "SG"],
  ["ZA"],
  ["RU", "UA"],
];

/** The country's neighbours that have a known marketplace, best first. Never contains the country itself. */
export function regionalPeers(country: string | null): string[] {
  const c = (country ?? "").toUpperCase();
  if (!c || c === "ZZ") return [];
  const out: string[] = [];
  for (const g of REGION_GROUPS) {
    if (!g.includes(c)) continue;
    for (const p of g) if (p !== c && MARKETPLACES[p] && !out.includes(p)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- thin data

/**
 * Countries where Google shows many final sale prices (mostly because eBay or a big local auction
 * site is large there). Everywhere else sold prices are rare, so a global search is started at
 * the same time as the local ones instead of waiting for them to fail.
 * STARTING VALUES. `learned` (country -> mean sold prices per local search, measured by the
 * nightly learner) overrides them when it is known.
 */
//
// SWEDEN IS DELIBERATELY NOT ON THIS LIST. It was, as a guess. A wrong guess is not symmetric:
//   - listed as rich but really thin: no global search is started, so a Swedish user gets few sold prices, AND
//     no foreign listing ever exists, so the learned price level (_shared/offsets.ts) can never be measured;
//   - listed as thin but really rich: one extra search runs in parallel (about 0.001 USD, no added waiting
//     time), and the learner corrects the list for free once it has COUNTRY_STATS_MIN_N searches.
// So a country is only put here after `assumptionCheck` shows it
// is rich with enough searches behind it. Never add a country on a hunch.
export const DATA_RICH: ReadonlySet<string> = new Set(["US", "GB", "DE", "AU", "CA", "FR", "IT", "ES", "NL", "JP", "AT", "IE"]);
/** Below this many sold prices per local search a country counts as thin. */
export const THIN_BELOW_SOLD_PER_SEARCH = 1.2;
/** At or above this many sold prices per local search a country is rich enough that the Search AI skips the global search. */
export const HIGH_SOLD_PER_SEARCH = 2.0;
/** A learned country figure is trusted only after this many local searches (the learner's `country_stats.n`). */
export const COUNTRY_STATS_MIN_N = 30;

export function isThinData(country: string | null, learned?: ReadonlyMap<string, number>): boolean {
  const c = (country ?? "").toUpperCase();
  if (!c || c === "ZZ") return false; // unknown country: everything counts as local, nothing is foreign
  const measured = learned?.get(c);
  if (measured !== undefined && Number.isFinite(measured)) return measured < THIN_BELOW_SOLD_PER_SEARCH;
  return !DATA_RICH.has(c);
}

// ---------------------------------------------------------------- is the starting list right?

export type AssumptionStatus = "confirmed" | "contradicted" | "waiting" | "no_data";

export interface AssumptionRow {
  country: string;
  /** What the starting list says: rich (on DATA_RICH) or thin (not on it). */
  assumed: "rich" | "thin";
  /** Kept sold prices per local search, as measured; null when the country has no statistics yet. */
  measured: number | null;
  /** Local searches behind the measurement. */
  n: number;
  /** confirmed / contradicted: the measurement (trusted from COUNTRY_STATS_MIN_N searches) agrees or not. waiting: measured, too few searches. */
  status: AssumptionStatus;
}

/**
 * Checks the starting list (DATA_RICH) against what the nightly learner measured. A contradicted row is
 * already corrected automatically in the Brain (isThinData prefers a trusted measurement), but it tells the
 * owner the list itself is wrong, so edit it (and markets.json) and keep the two files equal.
 * Covers every country on the list plus every country with statistics, most searches first.
 */
export function assumptionCheck(stats: readonly CountryStat[]): AssumptionRow[] {
  const byCountry = new Map(stats.map((s) => [s.country, s]));
  const countries = new Set<string>([...DATA_RICH, ...byCountry.keys()]);
  const rows: AssumptionRow[] = [];
  for (const country of countries) {
    const assumed = DATA_RICH.has(country) ? "rich" : "thin";
    const s = byCountry.get(country);
    if (!s) {
      rows.push({ country, assumed, measured: null, n: 0, status: "no_data" });
      continue;
    }
    let status: AssumptionStatus = "waiting";
    if (s.n >= COUNTRY_STATS_MIN_N) {
      const measuredRich = s.soldPerSearch >= THIN_BELOW_SOLD_PER_SEARCH;
      status = measuredRich === (assumed === "rich") ? "confirmed" : "contradicted";
    }
    rows.push({ country, assumed, measured: Math.round(s.soldPerSearch * 1000) / 1000, n: s.n, status });
  }
  return rows.sort((a, b) => b.n - a.n || a.country.localeCompare(b.country));
}

// ---------------------------------------------------------------- what the learner measured

/** One country's measured yield: kept sold prices per LOCAL search, and how many searches it rests on. */
export interface CountryStat {
  country: string;
  soldPerSearch: number;
  n: number;
}

/**
 * Reads `policy.training.country_stats` as written by the nightly learner
 * (`{ "SE": { "sold_per_search": 1.9, "n": 412 } }`). Anything malformed is skipped: a broken
 * row must never reach the maths.
 */
export function parseCountryStats(raw: unknown): CountryStat[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const out: CountryStat[] = [];
  for (const [country, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Z]{2}$/.test(country) || country === "ZZ" || typeof v !== "object" || v === null) continue;
    const rec = v as Record<string, unknown>;
    const soldPerSearch = Number(rec["sold_per_search"]);
    const n = Number(rec["n"]);
    if (Number.isFinite(soldPerSearch) && soldPerSearch >= 0 && Number.isInteger(n) && n >= 0) out.push({ country, soldPerSearch, n });
  }
  return out;
}

/** The map `isThinData` reads: only countries with at least COUNTRY_STATS_MIN_N local searches are trusted. */
export function learnedSoldPerSearch(stats: readonly CountryStat[]): Map<string, number> {
  return new Map(stats.filter((c) => c.n >= COUNTRY_STATS_MIN_N).map((c) => [c.country, c.soldPerSearch]));
}

// ---------------------------------------------------------------- where does a listing come from?

const CC_TLD: Record<string, string> = {
  "co.uk": "GB", uk: "GB", "com.au": "AU", au: "AU", "co.nz": "NZ", nz: "NZ", "com.sg": "SG", "com.hk": "HK",
  "com.br": "BR", "com.mx": "MX", "com.tw": "TW", "co.jp": "JP", "co.kr": "KR", "co.za": "ZA", "com.tr": "TR",
  de: "DE", at: "AT", ch: "CH", fr: "FR", be: "BE", nl: "NL", lu: "LU", es: "ES", pt: "PT", it: "IT", pl: "PL",
  cz: "CZ", hu: "HU", ro: "RO", gr: "GR", tr: "TR", se: "SE", no: "NO", dk: "DK", fi: "FI", is: "IS", ie: "IE",
  ca: "CA", jp: "JP", kr: "KR", cn: "CN", tw: "TW", th: "TH", id: "ID", vn: "VN", ph: "PH", my: "MY", in: "IN",
  il: "IL", ae: "AE", sa: "SA", ua: "UA", ru: "RU", br: "BR", mx: "MX", ar: "AR", cl: "CL", co: "CO", za: "ZA",
};

/** host -> country for the big marketplaces ("tradera.com" is Swedish, "ebay.com" is American). */
const HOST_COUNTRY: Map<string, string> = (() => {
  const m = new Map<string, string>([["ebay.com", "US"]]);
  for (const [country, hosts] of Object.entries(MARKETPLACES)) for (const h of hosts) if (!m.has(h)) m.set(h, country);
  return m;
})();

/**
 * The country a listing belongs to. The page decides first (a ".de" page is German whatever the
 * search was aimed at, "ebay.com" is American), and the search's own `gl` is only the last resort,
 * for global sites that carry no country of their own (a watch dealer, a record shop ...).
 */
export function findingCountry(host: string, gl: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const known = HOST_COUNTRY.get(h);
  if (known) return known;
  const parts = h.split(".");
  for (let n = Math.min(3, parts.length - 1); n >= 1; n--) {
    const tld = parts.slice(-n).join(".");
    const cc = CC_TLD[tld];
    if (cc && (n > 1 || parts.length >= 2)) return cc;
  }
  return /^[a-z]{2}$/i.test(gl) ? gl.toUpperCase() : "US";
}

/** The tier of a listing from `origin` for a user in `userCountry`. Unknown user country: always local. */
export function tierOf(origin: string, userCountry: string | null): Tier {
  const u = (userCountry ?? "").toUpperCase();
  if (!u || u === "ZZ") return "local";
  const o = origin.toUpperCase();
  if (o === u) return "local";
  if (regionalPeers(u).includes(o)) return "regional";
  return "global";
}

// ---------------------------------------------------------------- the weight of a tier

/** Inverse-variance weight of a tier relative to a local listing: 1 (local), about 0.80, about 0.55. */
export function tierWeight(tier: Tier | undefined): number {
  const s = FOREIGN_STD[tier ?? "local"];
  return FOREIGN_NOISE_S0 ** 2 / (FOREIGN_NOISE_S0 ** 2 + s ** 2);
}

/** Sold prices counted by how well they speak for the user's country: 5 local = 5, 5 global is about 2.7. */
export function effectiveSold(findings: readonly { kind: string; tier?: Tier }[]): number {
  return findings.reduce((s, f) => s + (f.kind === "sold" ? tierWeight(f.tier) : 0), 0);
}

/** Local first, then regional, then global. Used to order listings of the same kind. */
export function tierRank(tier: Tier | undefined): number {
  return tier === "global" ? 2 : tier === "regional" ? 1 : 0;
}

// ---------------------------------------------------------------- what the result says about itself

export type MarketBasisLevel = Tier | "none";

export interface MarketBasis {
  /** The user's market (ISO alpha-2), or "ZZ" when unknown. Saved with the valuation in Memory. */
  country: string;
  /**
   * Where the evidence behind the price comes from. "local" ONLY when almost all kept listings are
   * from the user's own country. Otherwise the tier that carries the most weight among the foreign
   * ones. "none" when there are no listings and the price rests on the photo alone.
   */
  basis: MarketBasisLevel;
  /** Number of kept listings per tier. */
  local: number;
  regional: number;
  global: number;
}

/** A listing is "mostly local" when foreign listings carry less than this share of the weight. */
export const LOCAL_SHARE_FOREIGN_BELOW = 0.2;

export function marketBasis(country: string | null, kept: readonly { tier?: Tier }[]): MarketBasis {
  const c = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "ZZ";
  const n = { local: 0, regional: 0, global: 0 };
  for (const f of kept) n[f.tier ?? "local"]++;
  const total = n.local + n.regional + n.global;
  if (total === 0) return { country: c, basis: "none", ...n };
  const foreign = n.regional + n.global;
  if (foreign / total < LOCAL_SHARE_FOREIGN_BELOW) return { country: c, basis: "local", ...n };
  return { country: c, basis: n.global >= n.regional ? "global" : "regional", ...n };
}

// ---------------------------------------------------------------- escalation searches

export const SOLD_WORD: Record<string, string> = {
  sv: "såld slutpris", no: "solgt", da: "solgt", fi: "myyty", is: "selt", de: "verkauft", fr: "vendu", es: "vendido",
  it: "venduto", nl: "verkocht", pt: "vendido", pl: "sprzedane", cs: "prodáno", hu: "eladva", ro: "vândut",
  el: "πωλήθηκε", tr: "satıldı", ja: "落札", ko: "판매완료", id: "terjual", vi: "đã bán", th: "ขายแล้ว", en: "sold",
};

export function soldWordFor(lang: string): string {
  return SOLD_WORD[lang.toLowerCase().split("-")[0]] ?? "sold";
}

/** Human name of a language, in English, for the Identification prompt. */
export function languageName(lang: string): string {
  const base = lang.toLowerCase();
  try {
    const n = new Intl.DisplayNames(["en"], { type: "language" }).of(base === "zh-cn" ? "zh-Hans" : base === "zh-tw" ? "zh-Hant" : base);
    if (n && n.toLowerCase() !== base) return n;
  } catch {
    // fall through
  }
  return base;
}

function itemTextOf(fp: Fingerprint): string {
  const parts = [fp.brand, fp.model ?? fp.type].filter((p): p is string => Boolean(p));
  return (parts.join(" ").trim() || fp.type).replace(/\s+/g, " ").slice(0, 80);
}

/**
 * The next searches when the tier below did not give enough sold prices. `have` holds the queries
 * already used (lower case), so nothing is searched twice. Returns at most one search per tier.
 * Pure: the caller decides when it is worth the time.
 */
export function escalationSearches(
  fp: Fingerprint,
  tiers: readonly Tier[],
  have: ReadonlySet<string>,
  nextNumber: number,
): PlannedSearch[] {
  const user = fp.country === "ZZ" ? "" : fp.country.toUpperCase();
  const item = itemTextOf(fp);
  const out: PlannedSearch[] = [];
  const add = (query: string, template_id: string, gl: string, hl: string, tier: Tier) => {
    const key = query.toLowerCase();
    if (query.length < 3 || query.length > 120 || have.has(key) || out.some((o) => o.query.toLowerCase() === key)) return false;
    out.push({ id: `s${nextNumber + out.length}`, query, template_id, kind: "fixed", gl, hl, tier });
    return true;
  };

  for (const tier of tiers) {
    if (tier === "regional") {
      for (const peer of regionalPeers(user)) {
        const lang = languageOf(peer);
        const site = MARKETPLACES[peer]?.[0];
        const q = `${item} ${soldWordFor(lang)}`;
        if (add(q, `esc_regional_${peer.toLowerCase()}`, peer.toLowerCase(), lang.split("-")[0], "regional")) break;
        if (site && add(`${item} site:${site}`, `esc_regional_site_${peer.toLowerCase()}`, peer.toLowerCase(), lang.split("-")[0], "regional")) break;
      }
    } else if (tier === "global") {
      const specialist = specialistFor(`${fp.category} ${fp.type}`);
      const options: [string, string][] = [
        ...(fp.mode === "retail" ? ([[`${item} price`, "esc_global_retail"]] as [string, string][]) : []),
        ...(fp.mode === "auction" ? ([[`${item} hammer price`, "esc_global_hammer"], [`${item} price realized`, "esc_global_realized"]] as [string, string][]) : []),
        [`${item} sold ebay`, "esc_global_ebay"],
        ...(specialist ? ([[`${item} sold site:${specialist}`, "esc_global_specialist"]] as [string, string][]) : []),
        [`${item} "sold" site:ebay.com`, "esc_global_ebay_completed"],
      ];
      for (const [q, id] of options) if (add(q, id, "us", "en", "global")) break;
    }
  }
  return out;
}

/** Which tiers to try next. The thinner the data so far, the faster the jump: nothing at all means both at once. */
export function nextTiers(done: readonly Tier[], soldSoFar: number): Tier[] {
  const todo = (["regional", "global"] as const).filter((t) => !done.includes(t));
  if (todo.length === 0) return [];
  return soldSoFar < 1 ? [...todo] : [todo[0]];
}

/** The language of the market (for tests and the prompt). */
export { COUNTRY_LANGUAGE };
