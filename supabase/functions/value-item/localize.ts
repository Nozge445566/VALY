// Converts a finished result (in USD) to the user's currency with the latest rates.
// Done every time a result leaves the server, also for cached results, so the amounts
// always follow today's exchange rate.

import { ceilLocal, floorLocal, niceStepLocal, roundLocal } from "./numbers.ts";
import { currencyDecimals } from "../_shared/currency-data.ts";
import type { FxTable } from "./fx.ts";
import type { BrainResult } from "./types.ts";
import { T } from "./lang.ts";
import type { Lang } from "./lang.ts";

export function localizeResult(result: BrainResult, fx: FxTable, currency: string, lang?: Lang): BrainResult {
  const code = currency.toUpperCase();
  const rate = code === "USD" ? 1 : fx.rates[code];
  // An unknown currency is answered in USD, and the result says so in `currency`.
  const useRate = rate !== undefined && rate > 0 ? rate : 1;
  const outCode = rate !== undefined && rate > 0 ? code : "USD";

  // The interval is rounded outwards (low floors, high ceils) so rounding never shrinks it,
  // and low < mid < high always holds (spec 4J).
  const dec = currencyDecimals(outCode);
  const rawMid = result.mid * useRate;
  const mid = roundLocal(rawMid, dec);
  let low = floorLocal(result.low * useRate, dec);
  let high = ceilLocal(result.high * useRate, dec);
  if (mid > 0) {
    if (low >= mid) low = Math.max(0, Math.round((mid - niceStepLocal(mid, dec)) * 10 ** dec) / 10 ** dec);
    if (high <= mid) high = Math.round((mid + niceStepLocal(mid, dec)) * 10 ** dec) / 10 ** dec;
  }

  const factors = [...result.factors];
  if (fx.source === "fallback") {
    factors.push({
      label: T(lang).labels.fx,
      detail: T(lang).fxFallback,
    });
  }

  // Rates older than 3 hours (last-good table, not live): show their age.
  if (fx.source === "cached" && Number.isFinite(Date.parse(String(fx.asOf)))) {
    const hours = Math.round((Date.now() - Date.parse(String(fx.asOf))) / 3_600_000);
    if (hours >= 3) factors.push({ label: T(lang).labels.fx, detail: T(lang).fxStale(hours) });
  }

  // The requested currency has no rate: say so plainly (never pass USD off as the user's currency).
  if (!(rate !== undefined && rate > 0) && code !== "USD") {
    factors.push({ label: T(lang).labels.fx, detail: T(lang).fxUnknownCurrency(code) });
  }

  return {
    ...result,
    currency: outCode,
    low,
    mid,
    high,
    comparables: result.comparables.map((c) => ({ ...c, price: Math.round(c.price * useRate * 10 ** dec) / 10 ** dec })),
    factors,
    fx: { source: fx.source, asOf: fx.asOf },
  };
}
