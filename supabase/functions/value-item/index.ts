// Supabase Edge Function "value-item": the entry point of the Brain.
//
// Secrets (set with `supabase secrets set NAME=value`):
//   ANTHROPIC_API_KEY   required   Detail eye, Identification (Haiku) and the Judge (Haiku, labels only)
//   SERPER_API_KEY      required for live listings (Market Live). Without it the Brain uses the no-market ladder (estimate from the eyes and Identification, see anchor.ts)
//   EYES_MODEL          optional   default claude-haiku-5-5
//   JUDGE_MODEL         optional   default claude-haiku-5-5
//   ANSWER_LIMIT_MS     optional   hard limit of the answer, default and maximum 7000
//   EYES_WINDOW_MS / SEARCH_WINDOW_MS   optional timing knobs (defaults 1500 / 2000)
//   MARKET_MIN_MATCH (0.8) / MARKET_MIN_ADS (2) / MARKET_MAX_ADS (3)   optional: when "Se marknadsdata" shows (market-ads.ts)
//   MEMORY_MAX_AGE_DAYS / MEMORY_MIN_CONFIDENCE / MEMORY_MIN_IDENT_CONFIDENCE   optional Memory rules
//   PROTECTION_PER_HOUR (20, counted valuations per device) / PROTECTION_ATTEMPTS_PER_HOUR (60, all attempts per device)
//   PROTECTION_IP_PER_HOUR (500, per network address) / PROTECTION_DAILY_CAP (1500, rolling 24 h)   optional
//   PLAN_LIMITS_ENABLED optional   "true" turns the plan limits (Free 20 in total, Pro 300/month, Premium 1000/month) ON. Default off. Set together with DAILY_LIMIT_ENABLED in src/lib/useDailyQuota.ts
//   SERPER_COST_USD     optional   cost of one search written to the search log, default 0.001
//   FX_URL              optional   extra exchange-rate source (JSON with a `rates` object)
//   CONNECTOR_SHARE     optional   The Connector AI (connector.ts) is always on. Share of valuations that get the change, default 0.5 (the rest are the control group)
//   CONNECTOR_MIN_SHARE optional   lowest share the learned dial may push it to, default 0.05
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically. The Search AI runs inside this function
// (_shared/search-ai) and reads its learned strategy with them; POLICY_REFRESH_SECONDS (300) is an optional knob.

import { loadConfig } from "./config.ts";
import { DEFAULT_LIMITS, handleRequest } from "./handler.ts";
import { createStore } from "./store.ts";

function intEnv(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const store = supabaseUrl && serviceKey ? createStore(supabaseUrl, serviceKey) : null;

const deps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log: (message: string, extra?: unknown) => console.error(`[Brain] ${message}`, extra ?? ""),
};

const limits = {
  perUserHour: intEnv("PROTECTION_PER_HOUR", DEFAULT_LIMITS.perUserHour),
  attemptsPerUserHour: intEnv("PROTECTION_ATTEMPTS_PER_HOUR", DEFAULT_LIMITS.attemptsPerUserHour),
  perIpHour: intEnv("PROTECTION_IP_PER_HOUR", DEFAULT_LIMITS.perIpHour),
  perDay: intEnv("PROTECTION_DAILY_CAP", DEFAULT_LIMITS.perDay),
};

// Work that may finish after the answer was sent (writing the learner's log).
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
function background(work: Promise<unknown>): void {
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
  else void work.catch(() => undefined);
}

Deno.serve((req) =>
  handleRequest(req, { getConfig: () => loadConfig((k) => Deno.env.get(k)), store, deps, limits, background, planLimitsEnabled: Deno.env.get("PLAN_LIMITS_ENABLED") === "true" })
);
