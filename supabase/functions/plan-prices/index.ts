// Supabase Edge Function "plan-prices": the plan prices (SEK) in the phone's currency, with the same live exchange rates
// the valuations use (value-item/fx.ts, refreshed every 5 minutes). Money is converted here, never in the browser.
// POST { currency: "USD", amounts: [0, 99, 199, 749] } -> { ok: true, currency, amounts, asOf, source }
// or { ok: false } when there are no live rates (the app then shows SEK). No secrets needed.
import { getFxTable } from "../value-item/fx.ts";
import { convertPlanAmounts, parsePlanPriceRequest } from "./convert.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

const deps = {
  fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  log: (message: string, extra?: unknown) => console.error(`[plan-prices] ${message}`, extra ?? ""),
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = parsePlanPriceRequest(raw);
  if (!parsed) return json({ error: "invalid request" }, 400);

  const fx = await getFxTable(deps);
  // The built-in table is only a rough last resort: never show it as a price.
  if (fx.source === "fallback") return json({ ok: false });
  const amounts = convertPlanAmounts(parsed.amounts, parsed.currency, fx.rates);
  if (!amounts) return json({ ok: false });
  return json({ ok: true, currency: parsed.currency, amounts, asOf: fx.asOf, source: fx.source });
});
