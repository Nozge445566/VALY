// Pure helpers for the "plan-prices" function: validate the request and convert the plan prices (SEK) with exchange rates.
import { convertCurrency } from "../value-item/fx.ts";
import { FALLBACK_RATES_FULL, currencyDecimals } from "../_shared/currency-data.ts";

export const BASE_CURRENCY = "SEK";
const MAX_AMOUNTS = 12;
const MAX_AMOUNT = 1_000_000;

export interface PlanPriceRequest {
  currency: string;
  /** Prices in SEK, in the order the app shows them. */
  amounts: number[];
}

/** null when the request is not a currency code the app knows and a short list of sane SEK amounts. */
export function parsePlanPriceRequest(raw: unknown): PlanPriceRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const currency = typeof b["currency"] === "string" ? b["currency"].trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency) || !(currency in FALLBACK_RATES_FULL)) return null;
  const amounts = b["amounts"];
  if (!Array.isArray(amounts) || amounts.length === 0 || amounts.length > MAX_AMOUNTS) return null;
  if (!amounts.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_AMOUNT)) return null;
  return { currency, amounts: amounts as number[] };
}

/** SEK amounts -> amounts in `currency`, rounded to that currency's own decimals. null when a rate is missing. */
export function convertPlanAmounts(amounts: readonly number[], currency: string, rates: Record<string, number>): number[] | null {
  const decimals = currencyDecimals(currency);
  const f = 10 ** decimals;
  const out: number[] = [];
  for (const a of amounts) {
    const v = convertCurrency(a, BASE_CURRENCY, currency, rates);
    if (v === null || !Number.isFinite(v)) return null;
    out.push(Math.round(v * f) / f);
  }
  return out;
}
