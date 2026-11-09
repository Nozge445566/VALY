// Exchange rates.
//
// All money inside L is in US dollars (the models are asked for USD, listings found on
// the web are converted to USD). Only at the very end is the amount converted to the
// user's currency, with live rates, so the same photo gives the same value everywhere.
//
// Rates come from free public sources that update about once a day (that is as live as
// free sources get). They are kept for one hour, checked for sanity, and if every source
// fails the last good rates (or, at the very end, a built-in table) are used and the
// result says so. Set FX_URL to plug in a paid source that updates more often; it must
// return JSON with a `rates` object (units per base currency) like the free ones.

import type { Deps } from "./config.ts";
import { FALLBACK_RATES_FULL } from "../_shared/currency-data.ts";

/** Units of currency per 1 USD. Last-resort table. Only used when no live rate exists. */
export const FALLBACK_RATES: Record<string, number> = { ...FALLBACK_RATES_FULL };

export interface FxTable {
  /** Units of currency per 1 USD. */
  rates: Record<string, number>;
  /** When the source last updated its rates (ISO), if it says. */
  asOf: string | null;
  /** live: fetched now. cached: fetched earlier and still fresh enough. fallback: built-in table. */
  source: "live" | "cached" | "fallback";
}

// Four independent public sources (owner: real time, every currency). Order = preference; the first sane answer wins.
export const DEFAULT_FX_URLS = [
  "https://open.er-api.com/v6/latest/USD",
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json",
  "https://latest.currency-api.pages.dev/v1/currencies/usd.json",
  "https://api.frankfurter.app/latest?from=USD",
];

export const TTL_MS = 5 * 60 * 1000; // refresh after five minutes (was one hour)
const MAX_STALE_MS = 24 * 60 * 60 * 1000; // memory older than a day: do not trust
const STORED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // the last-good table saved in Supabase: usable up to a week, flagged as cached
const FETCH_BUDGET_MS = 1200;
const REVALIDATE_WAIT_MS = 500; // stale-while-revalidate: a scan waits at most this long for a refresh, then answers with the last good table

/** Last good table kept outside the function (Supabase l_fx_rates), so a cold start with every source down still has real rates. */
export interface FxPersist {
  load(): Promise<{ rates: Record<string, number>; asOf: string | null; savedAt: number } | null>;
  save(t: { rates: Record<string, number>; asOf: string | null }): Promise<void>;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads the common JSON shapes of rate providers. Returns rates as units per USD. */
export function parseRates(json: unknown): { rates: Record<string, number>; asOf: string | null } | null {
  if (!isRec(json)) return null;
  // jsDelivr / Cloudflare currency-api shape: { date, usd: { eur: 0.92, ... } } (lowercase codes, also lists crypto: keep ISO table codes only)
  if (isRec(json["usd"]) && json["rates"] === undefined) {
    const out: Record<string, number> = { USD: 1 };
    for (const [c, v] of Object.entries(json["usd"] as Record<string, unknown>)) {
      const code = c.toUpperCase();
      if (code in FALLBACK_RATES_FULL && typeof v === "number" && Number.isFinite(v) && v > 0) out[code] = v;
    }
    return { rates: out, asOf: readAsOf(json) };
  }
  if (json["result"] !== undefined && json["result"] !== "success") return null;
  const raw = json["rates"];
  if (!isRec(raw)) return null;

  const rates: Record<string, number> = {};
  for (const [code, v] of Object.entries(raw)) {
    if (/^[A-Z]{3}$/.test(code) && typeof v === "number" && Number.isFinite(v) && v > 0) rates[code] = v;
  }

  const baseRaw = json["base_code"] ?? json["base"] ?? "USD";
  const base = typeof baseRaw === "string" ? baseRaw.toUpperCase() : "USD";
  if (base !== "USD") {
    const usdPerBase = rates["USD"];
    if (!usdPerBase) return null;
    const rebased: Record<string, number> = {};
    for (const [code, v] of Object.entries(rates)) rebased[code] = v / usdPerBase;
    rebased[base] = 1 / usdPerBase;
    rebased["USD"] = 1;
    return { rates: rebased, asOf: readAsOf(json) };
  }
  rates["USD"] = 1;
  return { rates, asOf: readAsOf(json) };
}

function readAsOf(json: Record<string, unknown>): string | null {
  for (const key of ["time_last_update_unix", "timestamp"]) {
    const v = json[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  }
  const d = json["date"];
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T00:00:00.000Z`;
  return null;
}

/** Rejects rate tables that look broken: too few currencies, or big currencies far off. */
export function ratesLookSane(rates: Record<string, number>): boolean {
  if (Object.keys(rates).length < 20) return false;
  for (const code of ["EUR", "GBP", "JPY", "SEK", "CAD", "AUD", "CHF", "CNY", "INR", "BRL"]) {
    const live = rates[code];
    const ref = FALLBACK_RATES[code];
    if (live === undefined) continue;
    const ratio = live / ref;
    if (!(ratio > 0.6 && ratio < 1.6)) return false;
  }
  return true;
}

async function fetchRates(
  deps: Deps,
  urls: string[],
): Promise<{ rates: Record<string, number>; asOf: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_BUDGET_MS);
  try {
    for (const url of urls) {
      try {
        const res = await deps.fetch(url, { signal: controller.signal });
        if (!res.ok) continue;
        const parsed = parseRates(await res.json());
        if (parsed && ratesLookSane(parsed.rates)) return parsed;
      } catch {
        if (controller.signal.aborted) break;
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let memo: { rates: Record<string, number>; asOf: string | null; fetchedAt: number } | null = null;
let inflight: Promise<{ rates: Record<string, number>; asOf: string | null } | null> | null = null;

/** For tests. */
export function resetFxMemo(): void {
  memo = null;
  inflight = null;
}

function refresh(deps: Deps, urls: string[], persist?: FxPersist | null) {
  if (!inflight) {
    inflight = fetchRates(deps, urls)
      .then((live) => {
        if (live) {
          memo = { rates: { ...FALLBACK_RATES, ...live.rates }, asOf: live.asOf, fetchedAt: deps.now() };
          if (persist) persist.save({ rates: live.rates, asOf: live.asOf }).catch(() => {});
        }
        return live;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Best available rates right now. Never throws and never takes longer than a few seconds.
 * Order: fresh memory (5 min) -> live sources (stale memory is served after REVALIDATE_WAIT_MS if the refresh is slow) ->
 * stale memory (up to a day) -> last-good table from Supabase (up to a week, reported as "cached" with its real asOf) ->
 * built-in approximate table (reported as "fallback"). Built-in rates fill any currency a live source does not list.
 */
export async function getFxTable(deps: Deps, extraUrl?: string | null, persist?: FxPersist | null): Promise<FxTable> {
  const now = deps.now();
  if (memo && now - memo.fetchedAt < TTL_MS) {
    return { rates: memo.rates, asOf: memo.asOf, source: "cached" };
  }
  const urls = extraUrl ? [extraUrl, ...DEFAULT_FX_URLS] : DEFAULT_FX_URLS;
  const pending = refresh(deps, urls, persist);
  const stale = memo && now - memo.fetchedAt < MAX_STALE_MS ? memo : null;
  let live: { rates: Record<string, number>; asOf: string | null } | null;
  if (stale) {
    // stale-while-revalidate: do not hold the scan for a slow source
    live = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), REVALIDATE_WAIT_MS))]);
    if (!live) return { rates: stale.rates, asOf: stale.asOf, source: "cached" };
  } else {
    live = await pending;
  }
  if (live) return { rates: { ...FALLBACK_RATES, ...live.rates }, asOf: live.asOf, source: "live" };

  deps.log("exchange rate sources failed");
  if (stale) return { rates: stale.rates, asOf: stale.asOf, source: "cached" };
  if (persist) {
    try {
      const saved = await persist.load();
      if (saved && now - saved.savedAt < STORED_MAX_AGE_MS && ratesLookSane({ ...FALLBACK_RATES, ...saved.rates })) {
        return { rates: { ...FALLBACK_RATES, ...saved.rates }, asOf: saved.asOf, source: "cached" };
      }
    } catch {
      /* fall through to the built-in table */
    }
  }
  return { rates: { ...FALLBACK_RATES }, asOf: null, source: "fallback" };
}

/** Converts using units-per-USD rates. Returns null when either currency is unknown. */
export function convertCurrency(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  const rf = rates[f];
  const rt = rates[t];
  if (!(rf > 0) || !(rt > 0)) return null;
  return (amount / rf) * rt;
}
