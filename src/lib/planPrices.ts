// Plan prices in the phone's currency. The prices are set in SEK (plans.ts); the server converts them with the same live
// exchange rates the valuations use (edge function "plan-prices"). Money is never converted in the browser.
// If the phone's currency is SEK, or the server has no live rates, the app simply shows SEK.

export interface ConvertedPrices {
  currency: string;
  /** In the same order as the amounts that were sent. */
  amounts: number[];
}

/** Asks the server for the SEK amounts in `currency`. null when not possible: the caller shows SEK. */
export async function fetchConvertedPrices(currency: string, amounts: readonly number[]): Promise<ConvertedPrices | null> {
  if (currency === "SEK") return null;
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const { data, error } = await supabase.functions.invoke("plan-prices", { body: { currency, amounts } });
    if (error || !data?.ok || data.currency !== currency || !Array.isArray(data.amounts) || data.amounts.length !== amounts.length) return null;
    if (!data.amounts.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
    return { currency, amounts: data.amounts as number[] };
  } catch {
    return null;
  }
}
