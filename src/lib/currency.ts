// Detect where the user is and which currency they use. Money is never converted in the
// browser: L (the server) converts with live exchange rates and sends finished amounts.

import { uiLocale } from "./i18n.ts";
import { COUNTRY_CURRENCY, currencyDecimals } from "./currency-data.ts";

/** Symbol for ANY ISO currency from the browser's own data (narrow symbol when it has one), else the code. */
function symbolOf(code: string, locale: string): string {
  try {
    const part = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency");
    return part?.value ?? code;
  } catch {
    return code;
  }
}

export interface Currency {
  code: string;
  symbol: string;
  locale: string;
  /** ISO 3166-1 alpha-2, when we could tell. Used to look at the right market. */
  country: string | null;
  /** True when no country could be found and USD is only a last resort (show a visible note). */
  guessed: boolean;
}

/** Time zone -> country. The device time zone tells where the user really is. */
const TIMEZONE_TO_REGION: Record<string, string> = {
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI",
  "Atlantic/Reykjavik": "IS", "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Berlin": "DE",
  "Europe/Vienna": "AT", "Europe/Zurich": "CH", "Europe/Paris": "FR", "Europe/Brussels": "BE",
  "Europe/Amsterdam": "NL", "Europe/Luxembourg": "LU", "Europe/Madrid": "ES", "Europe/Lisbon": "PT",
  "Europe/Rome": "IT", "Europe/Athens": "GR", "Europe/Warsaw": "PL", "Europe/Prague": "CZ",
  "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Sofia": "BG", "Europe/Kyiv": "UA",
  "Europe/Kiev": "UA", "Europe/Istanbul": "TR", "Europe/Moscow": "RU", "Europe/Tallinn": "EE",
  "Europe/Riga": "LV", "Europe/Vilnius": "LT", "Europe/Zagreb": "HR", "Europe/Belgrade": "RS",
  "Europe/Bratislava": "SK", "Europe/Ljubljana": "SI", "Europe/Malta": "MT",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
  "America/Phoenix": "US", "America/Anchorage": "US", "America/Detroit": "US", "Pacific/Honolulu": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA",
  "America/Halifax": "CA", "America/St_Johns": "CA", "America/Regina": "CA",
  "America/Mexico_City": "MX", "America/Sao_Paulo": "BR", "America/Buenos_Aires": "AR",
  "America/Bogota": "CO", "America/Lima": "PE", "America/Santiago": "CL", "America/Montevideo": "UY",
  "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Shanghai": "CN", "Asia/Hong_Kong": "HK",
  "Asia/Taipei": "TW", "Asia/Singapore": "SG", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
  "Asia/Bangkok": "TH", "Asia/Jakarta": "ID", "Asia/Kuala_Lumpur": "MY", "Asia/Ho_Chi_Minh": "VN",
  "Asia/Saigon": "VN", "Asia/Manila": "PH", "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Qatar": "QA",
  "Asia/Kuwait": "KW", "Asia/Jerusalem": "IL", "Asia/Tel_Aviv": "IL", "Asia/Karachi": "PK",
  "Asia/Dhaka": "BD", "Asia/Colombo": "LK", "Asia/Tbilisi": "GE", "Asia/Almaty": "KZ",
  "Pacific/Auckland": "NZ", "Africa/Johannesburg": "ZA", "Africa/Lagos": "NG", "Africa/Cairo": "EG",
  "Africa/Nairobi": "KE", "Africa/Casablanca": "MA",
};

function countryFromTimeZone(tz: string | undefined): string | null {
  if (!tz) return null;
  if (TIMEZONE_TO_REGION[tz]) return TIMEZONE_TO_REGION[tz];
  if (tz.startsWith("Australia/")) return "AU";
  if (tz.startsWith("America/Argentina/")) return "AR";
  if (tz.startsWith("America/Indiana/") || tz.startsWith("America/Kentucky/")) return "US";
  return null;
}

function countryFromLocale(locale: string): string | null {
  const m = /-([A-Za-z]{2})(?=-|$)/.exec(locale);
  return m ? m[1].toUpperCase() : null;
}

const cached: { currency: Currency | null } = { currency: null };

export function detectCurrency(): Currency {
  if (cached.currency) return cached.currency;

  const locale = navigator.languages?.[0] ?? navigator.language ?? "en-US";

  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }

  // Where the device is (time zone) is the best guide. Then the region of the browser language.
  const country = countryFromTimeZone(timeZone) ?? countryFromLocale(locale);

  // The currency follows the DEVICE country and nothing else (product rule: no picker, no override).
  // USD only when no country can be found at all; `guessed` tells the UI to show a visible note.
  const code = (country ? COUNTRY_CURRENCY[country] : undefined) ?? "USD";
  const guessed = !country || !COUNTRY_CURRENCY[country];

  cached.currency = { code, symbol: symbolOf(code, locale), locale, country, guessed };
  return cached.currency;
}

/** Formats an amount. Pass the currency of the amount; it defaults to the user's currency. */
export function formatMoney(n: number, code?: string): string {
  const cur = detectCurrency();
  const currency = code ?? cur.code;
  try {
    // Numbers follow the app language (Swedish phone: "1 200 kr"; anything else: English formatting).
    return new Intl.NumberFormat(uiLocale(), {
      style: "currency",
      currency,
      // ISO minor units: 0 for JPY/KRW/VND..., 3 for KWD/BHD..., amounts are already rounded by the server
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.min(currencyDecimals(currency), Math.abs(n) < 100 ? currencyDecimals(currency) : 0),
    }).format(n);
  } catch {
    return `${Math.round(n)} ${currency}`;
  }
}
