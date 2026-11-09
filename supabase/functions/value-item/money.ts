// Reading prices out of search results. This is plain code, never an AI: the diagram says
// "Code (not AI) extracts the price from the hits".

import type { ListingKind } from "./types.ts";
import { FALLBACK_RATES_FULL } from "../_shared/currency-data.ts";

export interface ParsedMoney {
  price: number;
  currency: string;
}

export interface MoneyContext {
  /** Host of the page the text came from, for example "www.ebay.co.uk". */
  host: string;
  /** Country the search was aimed at (lower case ISO alpha-2), for example "se". */
  gl: string;
}

const MIN_PRICE = 5;
/** ISO codes that are also everyday English words: never read as a currency. */
const WORD_LIKE_CODES = new Set(["ALL", "TOP", "MOP", "PEN", "CUP", "SOS", "BOB", "PAB", "GEL", "LAK", "KIP", "ANG", "BAM", "NAD", "TND_"]);
/** Currencies with 3 decimals: "KWD 12.500" is twelve and a half, not twelve thousand five hundred. */
const THREE_DECIMALS = new Set(["KWD", "BHD", "OMR", "JOD", "TND", "IQD", "LYD"]);
const MAX_LISTING_PRICE = 5_000_000;

const CODES = "USD|EUR|GBP|SEK|NOK|DKK|AUD|CAD|CHF|JPY|CNY|RMB|KRW|INR|PLN|CZK|BRL|MXN|NZD|SGD|HKD|TWD|TRY|ZAR|RUB|THB|HUF|RON|ILS|AED|SAR|MYR|IDR|PHP|VND|UAH|ISK";
// Every ISO code we hold a rate for. Letter codes outside the original list must be written in CAPITALS (see resolveCurrency).
const ALL_CODES = Object.keys(FALLBACK_RATES_FULL).filter((c) => /^[A-Z]{3}$/.test(c)).join("|");
// Symbols and words used by markets all over the world. Word-like ones may not touch another letter.
const WORD_TOKENS = String.raw`Rs\.?|Rp\.?|RM|Ksh|Lei|Ft|лв\.?|руб\.?|₽|₴|₦|₪|฿|₫|₱|₸|₾|₼|৳|៛|₭|₮|₡|₲|₵|S/\.?|د\.إ|ر\.س|ج\.م|د\.م\.?|ر\.ق|د\.ك|دج|د\.ب|ر\.ع|د\.أ|د\.ت|ل\.ل|د\.ع`;
const SYMBOLS = String.raw`(?:US|AU|CA|NZ|NT|HK|S|R|C|A)\s?\$|\$|€|£|¥|￥|円|₩|₹|₺|zł|Kč|kr\.?|:-|(?:${WORD_TOKENS})(?![\p{L}])`;
const NUM = String.raw`\d{1,3}(?:[ \u00a0,.'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

// A currency token before the number, or after it. Letter codes must not touch other letters.
const MONEY_RE = new RegExp(
  String.raw`(?:(?<![\p{L}])(${SYMBOLS}|(?:${CODES}|${ALL_CODES})(?![\p{L}]))\s?(${NUM}))|(?:(${NUM})\s?(${SYMBOLS}|(?:${CODES}|${ALL_CODES})(?![\p{L}])))`,
  "giu",
);

const SHIPPING_BEFORE = /(?:\+|plus|shipping|postage|frakt|porto|versand|ship(?:ping)?\s+from|was|rrp|msrp|retail|originally|new from)\s*:?\s*$/i;
// "$5 shipping" is a shipping price. "€ frakt 49 €" is not: there "frakt" labels the NEXT price.
const SHIPPING_AFTER = /^\s*(?:shipping|postage|frakt|porto|versand|delivery|p&p)\b(?!\s*:?\s*[\p{Sc}\d])/iu;

export function parseAmount(raw: string): number | null {
  const compact = raw.replace(/[\s\u00a0'’]/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  let normalized = compact;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? compact.replace(/\./g, "").replace(",", ".") : compact.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const frac = compact.length - lastComma - 1;
    normalized = frac === 3 ? compact.replace(/,/g, "") : compact.replace(",", ".");
  } else if (lastDot >= 0) {
    const frac = compact.length - lastDot - 1;
    if (frac === 3 || compact.split(".").length > 2) normalized = compact.replace(/\./g, "");
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function hostEndsWith(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase();
  return suffixes.some((s) => h.endsWith(s));
}

/** Turns a symbol or code into an ISO currency. Ambiguous symbols use the site and the country. */
export function resolveCurrency(token: string, ctx: MoneyContext): string | null {
  const raw = token.trim().replace(/\s+/g, "");
  const up = raw.toUpperCase();
  if (/^(USD|EUR|GBP|SEK|NOK|DKK|AUD|CAD|CHF|JPY|CNY|KRW|INR|PLN|CZK|BRL|MXN|NZD|SGD|HKD|TWD|TRY|ZAR|RUB|THB|HUF|RON|ILS|AED|SAR|MYR|IDR|PHP|VND|UAH|ISK)$/.test(up)) return up;
  // Any other ISO code we hold a rate for, only when written in CAPITALS and not an everyday word.
  if (raw === up && /^[A-Z]{3}$/.test(up) && up in FALLBACK_RATES_FULL && !WORD_LIKE_CODES.has(up)) return up;
  const hostL = ctx.host.toLowerCase();
  const glL = ctx.gl.toLowerCase();
  const at = (...sfx: string[]) => sfx.some((x) => hostL.endsWith(x)) ;
  const WORDS: Record<string, string> = {
    "₽": "RUB", "руб": "RUB", "руб.": "RUB", "₴": "UAH", "₦": "NGN", "₪": "ILS", "฿": "THB", "₫": "VND", "₱": "PHP", "₸": "KZT", "₾": "GEL",
    "₼": "AZN", "৳": "BDT", "៛": "KHR", "₭": "LAK", "₮": "MNT", "₡": "CRC", "₲": "PYG", "₵": "GHS",
    "RP": "IDR", "RP.": "IDR", "RM": "MYR", "KSH": "KES", "LEI": "RON", "S/": "PEN", "S/.": "PEN",
    "دج": "DZD", "د.إ": "AED", "ر.س": "SAR", "ج.م": "EGP", "د.م": "MAD", "د.م.": "MAD", "ر.ق": "QAR", "د.ك": "KWD", "د.ب": "BHD",
    "ر.ع": "OMR", "د.أ": "JOD", "د.ت": "TND", "ل.ل": "LBP", "د.ع": "IQD",
  };
  if (WORDS[up] ?? WORDS[raw]) return WORDS[up] ?? WORDS[raw];
  if (up === "ЛВ" || up === "ЛВ.") return "BGN";
  if (up === "RS" || up === "RS.") return at(".lk") || glL === "lk" ? "LKR" : at(".pk") || glL === "pk" ? "PKR" : at(".np") || glL === "np" ? "NPR" : "INR";
  // "Ft" is also feet: only when the page or the search is Hungarian.
  if (up === "FT") return at(".hu") || glL === "hu" ? "HUF" : null;
  if (up === "RMB") return "CNY";
  switch (raw) {
    case "€": return "EUR";
    case "£": return "GBP";
    case "₩": return "KRW";
    case "円": return "JPY";
    case "₹": return "INR";
    case "₺": return "TRY";
    case "zł": return "PLN";
    case "Kč": return "CZK";
  }
  switch (up) {
    case "US$": return "USD";
    case "AU$": case "A$": return "AUD";
    case "CA$": case "C$": return "CAD";
    case "NZ$": return "NZD";
    case "NT$": return "TWD";
    case "HK$": return "HKD";
    case "S$": return "SGD";
    case "R$": return "BRL";
  }
  const host = ctx.host.toLowerCase();
  const gl = ctx.gl.toLowerCase();
  if (raw === "$") {
    if (hostEndsWith(host, [".com.au", ".au"])) return "AUD";
    if (hostEndsWith(host, [".ca"])) return "CAD";
    if (hostEndsWith(host, [".co.nz", ".nz"])) return "NZD";
    if (hostEndsWith(host, [".com.sg", ".sg"])) return "SGD";
    if (hostEndsWith(host, [".com.hk", ".hk"])) return "HKD";
    if (hostEndsWith(host, [".com.mx", ".mx"])) return "MXN";
    // A global .com site shows dollars, whatever country the search was aimed at.
    return "USD";
  }
  if (raw === "¥" || raw === "￥") {
    if (hostEndsWith(host, [".cn"]) || (gl === "cn" && !hostEndsWith(host, [".jp"]))) return "CNY";
    return "JPY";
  }
  if (raw === "kr" || raw === "kr." || raw === ":-") {
    if (hostEndsWith(host, [".se"]) || gl === "se") return "SEK";
    if (hostEndsWith(host, [".no"]) || gl === "no") return "NOK";
    if (hostEndsWith(host, [".dk"]) || gl === "dk") return "DKK";
    if (hostEndsWith(host, [".is"]) || gl === "is") return "ISK";
    return null;
  }
  return null;
}

/** Pulls money amounts out of a listing title or snippet. At most 3, first is the main price. */
export function extractMoney(text: string, ctx: MoneyContext = { host: "", gl: "" }): ParsedMoney[] {
  const out: ParsedMoney[] = [];
  const seen = new Set<string>();
  MONEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY_RE.exec(text)) !== null) {
    const token = m[1] ?? m[4] ?? "";
    const rawNum = m[2] ?? m[3] ?? "";
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (SHIPPING_BEFORE.test(before) || SHIPPING_AFTER.test(after)) continue;
    const currency = resolveCurrency(token, ctx);
    if (!currency) continue;
    let price = parseAmount(rawNum);
    if (THREE_DECIMALS.has(currency) && /^\d{1,3}[.,]\d{3}$/.test(rawNum.trim())) price = Number(rawNum.trim().replace(",", "."));
    if (price === null || price < MIN_PRICE || price > MAX_LISTING_PRICE) continue;
    const key = `${currency}:${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ price, currency });
    if (out.length >= 3) break;
  }
  return out;
}

// ---------------------------------------------------------------- sold or asking?

/** Words that say "this price was paid", in the languages of the biggest trading markets. */
export const SOLD_WORDS: Record<string, string[]> = {
  en: ["sold", "sold for", "completed", "winning bid", "final price", "hammer price", "price realized", "auction ended"],
  sv: ["såld", "sålt", "slutpris", "avslutad"],
  no: ["solgt", "solgte"],
  da: ["solgt", "solgte"],
  de: ["verkauft", "beendet", "zuschlag"],
  fr: ["vendu", "vendue", "adjugé"],
  es: ["vendido", "vendida"],
  it: ["venduto", "venduta"],
  nl: ["verkocht"],
  pt: ["vendido", "vendida"],
  pl: ["sprzedane", "sprzedany"],
  ja: ["落札", "売却"],
  fi: ["myyty", "myyty hintaan"],
  cs: ["prodáno", "prodáno za"],
  hu: ["eladva", "elkelt"],
  ro: ["vândut"],
  ko: ["판매완료", "낙찰"],
  tr: ["satıldı"],
};

const ALL_SOLD = Array.from(new Set(Object.values(SOLD_WORDS).flat()));
const SOLD_RE = new RegExp(
  String.raw`(?<![\p{L}])(?:${ALL_SOLD.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\p{L}])(?!\s+by\b)`,
  "iu",
);
const NOT_SOLD_RE = /\b(?:sold\s+out|not\s+sold|unsold|no\s+longer\s+available|sold\s+and\s+shipped|ej\s+såld)\b/i;

/** "sold" only when the text clearly says the price was paid. Everything else is an asking price. */
export function listingKind(text: string): ListingKind {
  if (NOT_SOLD_RE.test(text)) return "asking";
  return SOLD_RE.test(text) ? "sold" : "asking";
}

export function hostOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return "";
  }
}

