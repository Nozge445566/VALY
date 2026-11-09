// The HTTP layer. It checks the request, runs Protection BEFORE any paid call, runs the Brain,
// saves new valuations, and answers. Kept free of Deno-only APIs so it can be tested with Node.
//
//   Photo -> Protection (here)        Photo -> Eyes / Judge (pipeline.ts)
//   Answer at 7 s, hard limit (here)  Answer -> Saved in Supabase, only new valuations (here)

import { applyAdCalibration } from "../_shared/judge-fit.ts";
import { BRAIN_VERSION } from "./config.ts";
import type { BrainConfig, Deps } from "./config.ts";
import { getFxTable } from "./fx.ts";
import { pickDisplayCurrency } from "../_shared/currency-data.ts";
import { parseDataUrl } from "./image.ts";
import { localizeResult } from "./localize.ts";
import { applyMarketAds } from "./market-ads.ts";
import { lookupK } from "../_shared/calibration.ts";
import { learnedSoldPerSearch } from "./market-tiers.ts";
import { offsetTable } from "../_shared/offsets.ts";
import type { OffsetTable } from "../_shared/offsets.ts";
import { memoryKey } from "./memory.ts";
import { runBrain } from "./pipeline.ts";
import { checkLimits } from "./plan-limits.ts";
import { DEFAULT_LIMITS, readDeviceId, verdictMessage } from "./protection.ts";
import type { AttemptCheck } from "./protection.ts";
import { T, langOfBody, langOfLocale } from "./lang.ts";
import type { Lang } from "./lang.ts";
import type { Limits } from "./protection.ts";
import type { LocalPlanFn } from "./search-ai.ts";
import type { Store } from "./store.ts";
import { StepError } from "./types.ts";
import type { BrainInput, BrainRun } from "./types.ts";

export { DEFAULT_LIMITS };
export type { Store };

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface HandlerContext {
  getConfig: () => BrainConfig;
  store: Store | null;
  deps: Deps;
  limits: Limits;
  /** Master switch for the plan limits (env PLAN_LIMITS_ENABLED=true). Off = nobody is blocked by a plan. */
  planLimitsEnabled?: boolean;
  /** Runs work after the answer has been sent (logging for the learner). */
  background: (work: Promise<unknown>) => void;
  /** The Search AI engine call. Without it the real in-process engine runs; tests pass a fake so nothing touches the network. */
  localPlan?: LocalPlanFn;
}

const MAX_BODY_CHARS = 7_000_000;
/** The answer is sent this long before the hard limit, so it still reaches the app in time. */
const SEND_MARGIN_MS = 60;
/** The Protection check may take this long at most. */
const PROTECTION_TIMEOUT_MS = 600;
/** Working out whether a finished valuation is a repeat may take this long at most, and never past the hard limit. */
const SETTLE_TIMEOUT_MS = 400;
/** Below this much time left before the hard limit the repeat check is not even started. */
const SETTLE_MIN_MS = 60;

// ---- Calibration: the width multiplier k per bucket (l_calibration), cached for 10 minutes.
// It may NEVER delay or break an answer: the load runs next to everything else, and the interval
// engine just reads whatever has arrived by then. No table, error or timeout means k = 1.
const CALIBRATION_TTL_MS = 10 * 60 * 1000;
const CALIBRATION_TIMEOUT_MS = 800;
interface CalibrationCache {
  table: Map<string, number>;
  loadedAt: number;
  loading: boolean;
}
const calibrationCaches = new WeakMap<Store, CalibrationCache>();

/** Judge band tables learned by the nightly fit (l_ad_calibration). Same rules as k: bounded, never delays or breaks an answer; no rows = defaults. */
async function loadAdBands(store: Store, timeoutMs: number, log: (m: string, e?: unknown) => void): Promise<void> {
  if (!store.loadAdCalibration) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([store.loadAdCalibration(), new Promise<null>((res) => { timer = setTimeout(() => res(null), timeoutMs); })]);
    if (rows && rows.length > 0) applyAdCalibration(rows);
  } catch (e) {
    log("ad calibration load failed", errorMessage(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Starts a refresh when the cache is empty or old. Returns at once. */
export function refreshCalibration(store: Store | null, now: number, log: (m: string, e?: unknown) => void): (bucket: string) => number | null {
  if (!store) return () => null;
  let cache = calibrationCaches.get(store);
  if (!cache) {
    cache = { table: new Map(), loadedAt: -Infinity, loading: false };
    calibrationCaches.set(store, cache);
  }
  const c = cache;
  if (!c.loading && now - c.loadedAt > CALIBRATION_TTL_MS) {
    c.loading = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const give_up = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CALIBRATION_TIMEOUT_MS);
    });
    Promise.race([store.loadCalibration(), give_up])
      .then((rows) => {
        if (rows) c.table = new Map(rows.map((r) => [r.bucket, r.k]));
      })
      .then(() => loadAdBands(store, CALIBRATION_TIMEOUT_MS, log))
      .catch((e) => log("calibration load failed", errorMessage(e)))
      .finally(() => {
        clearTimeout(timer);
        // Even a failed or slow load counts as an attempt: try again after the TTL, not every request.
        c.loadedAt = now;
        c.loading = false;
      });
  }
  return (bucket) => lookupK(c.table, bucket);
}

// ---- Country statistics (what the nightly learner measured per country): cached for 10 minutes,
// exactly like the calibration. They only decide whether a country counts as "thin" (market-tiers.ts),
// so they may NEVER delay or break an answer: no table, error or timeout means the starting list.
const COUNTRY_STATS_TTL_MS = 10 * 60 * 1000;
const COUNTRY_STATS_TIMEOUT_MS = 800;
interface CountryStatsCache {
  map: Map<string, number>;
  loadedAt: number;
  loading: boolean;
}
const countryStatsCaches = new WeakMap<Store, CountryStatsCache>();
const NO_COUNTRY_STATS: ReadonlyMap<string, number> = new Map();

/** Starts a refresh when the cache is empty or old. Returns at once; call the result when the numbers are needed. */
export function refreshCountryStats(store: Store | null, now: number, log: (m: string, e?: unknown) => void): () => ReadonlyMap<string, number> {
  if (!store) return () => NO_COUNTRY_STATS;
  let cache = countryStatsCaches.get(store);
  if (!cache) {
    cache = { map: new Map(), loadedAt: -Infinity, loading: false };
    countryStatsCaches.set(store, cache);
  }
  const c = cache;
  if (!c.loading && now - c.loadedAt > COUNTRY_STATS_TTL_MS) {
    c.loading = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const give_up = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), COUNTRY_STATS_TIMEOUT_MS);
    });
    Promise.race([store.loadCountryStats(), give_up])
      .then((rows) => {
        if (rows) c.map = learnedSoldPerSearch(rows);
      })
      .catch((e) => log("country stats load failed", errorMessage(e)))
      .finally(() => {
        clearTimeout(timer);
        c.loadedAt = now; // a failed or slow load also counts as an attempt: next try after the TTL
        c.loading = false;
      });
  }
  // Read at the moment Market Live starts, so a load that finished in the meantime is used.
  return () => c.map;
}

// ---- Learned price level per country pair (l_price_offsets): cached for 10 minutes, exactly like the
// calibration. It only moves foreign comparables toward the user's price level, so it may NEVER delay
// or break an answer: no table, error or timeout means no shift and the guessed FOREIGN_STD.
const OFFSETS_TTL_MS = 10 * 60 * 1000;
const OFFSETS_TIMEOUT_MS = 800;
interface OffsetsCache {
  table: OffsetTable | undefined;
  loadedAt: number;
  loading: boolean;
}
const offsetsCaches = new WeakMap<Store, OffsetsCache>();

/** Starts a refresh when the cache is empty or old. Returns at once; call the result when the table is needed. */
export function refreshPriceOffsets(store: Store | null, now: number, log: (m: string, e?: unknown) => void): () => OffsetTable | undefined {
  if (!store) return () => undefined;
  let cache = offsetsCaches.get(store);
  if (!cache) {
    cache = { table: undefined, loadedAt: -Infinity, loading: false };
    offsetsCaches.set(store, cache);
  }
  const c = cache;
  if (!c.loading && now - c.loadedAt > OFFSETS_TTL_MS) {
    c.loading = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const give_up = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), OFFSETS_TIMEOUT_MS);
    });
    Promise.race([store.loadPriceOffsets(), give_up])
      .then((rows) => {
        if (rows) c.table = offsetTable(rows);
      })
      .catch((e) => log("price offsets load failed", errorMessage(e)))
      .finally(() => {
        clearTimeout(timer);
        c.loadedAt = now; // a failed or slow load also counts as an attempt: next try after the TTL
        c.loading = false;
      });
  }
  return () => c.table;
}

// ---- Connector dials (l_connector_policy): cached for 10 minutes, exactly like the calibration. The dial only scales
// the share of valuations that get the Connector, so it may NEVER delay or break an answer: no table, error or timeout
// means no dial (every bucket counts as 1).
const CONNECTOR_TTL_MS = 10 * 60 * 1000;
const CONNECTOR_TIMEOUT_MS = 800;
interface ConnectorCache {
  map: Map<string, number>;
  loadedAt: number;
  loading: boolean;
}
const connectorCaches = new WeakMap<Store, ConnectorCache>();
const NO_CONNECTOR_POLICY: ReadonlyMap<string, number> = new Map();

/** Starts a refresh when the cache is empty or old. Returns at once. */
export function refreshConnectorPolicy(store: Store | null, now: number, log: (m: string, e?: unknown) => void): () => ReadonlyMap<string, number> {
  if (!store) return () => NO_CONNECTOR_POLICY;
  let cache = connectorCaches.get(store);
  if (!cache) {
    cache = { map: new Map(), loadedAt: -Infinity, loading: false };
    connectorCaches.set(store, cache);
  }
  const c = cache;
  if (!c.loading && now - c.loadedAt > CONNECTOR_TTL_MS) {
    c.loading = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const give_up = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), CONNECTOR_TIMEOUT_MS);
    });
    Promise.race([store.loadConnectorPolicy(), give_up])
      .then((rows) => {
        if (rows) c.map = new Map(rows.map((r) => [r.bucket, r.dial]));
      })
      .catch((e) => log("connector policy load failed", errorMessage(e)))
      .finally(() => {
        clearTimeout(timer);
        c.loadedAt = now; // a failed or slow load also counts as an attempt: next try after the TTL
        c.loading = false;
      });
  }
  return () => c.map;
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

/**
 * The language for errors that happen before the body is understood (wrong method, unreadable or too large body).
 * Order: an explicit `"lang":"sv"` in the raw text, else the browser's own Accept-Language header (the first tag, which is
 * the phone's preferred language), else English.
 */
export function earlyLang(req: Request, text?: string): Lang {
  const m = text ? /"lang"\s*:\s*"(sv|en)"/.exec(text.slice(0, 2000)) : null;
  if (m) return m[1] as Lang;
  const first = (req.headers.get("accept-language") ?? "").split(",")[0]?.split(";")[0] ?? "";
  return langOfLocale(first);
}

export function headerCountry(req: Request): string | null {
  const c = (req.headers.get("cf-ipcountry") ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1" ? c : null;
}

export interface ParsedRequest {
  input: BrainInput;
  currency: string;
  deviceId: string | null;
  /** Where the country came from: the device (app), the device language, the IP header, or nowhere (USD last resort). */
  countrySource: "device" | "locale" | "ip" | "none";
  /** Country seen by the network (cf-ipcountry); used only to log a mismatch with the device country. */
  ipCountry: string | null;
  /** Language of the words written for the person. */
  lang: Lang;
}

/** Reads and checks the request body. Returns an error message or a clean request. */
export function parseRequest(raw: unknown, fallbackCountry: string | null = null): { error: string } | { req: ParsedRequest } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: T(langOfBody(raw)).errors.invalid };
  const body = raw as Record<string, unknown>;
  const lang = langOfBody(body);

  const image = parseDataUrl(body["image"]);
  if (!image) return { error: T(lang).errors.photoUnreadable };

  const localeRaw = typeof body["locale"] === "string" ? body["locale"].trim() : "";
  const locale = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(localeRaw) ? localeRaw : "";
  const countryRaw = typeof body["country"] === "string" ? body["country"].trim().toUpperCase() : "";
  const region = locale ? /-([A-Z]{2})(?=-|$)/.exec(locale.toUpperCase()) : null;
  const country = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : region ? region[1] : fallbackCountry;

  // Display currency: ONLY the currency of the device's country (product rule). Any `currency` field the app
  // sends is ignored. Device country wins over the IP country (fallbackCountry); USD only if no country at all.
  const currency = pickDisplayCurrency(country).code ?? "USD";

  const countrySource = /^[A-Z]{2}$/.test(countryRaw) ? "device" : region ? "locale" : fallbackCountry ? "ip" : "none";
  return {
    req: {
      countrySource,
      ipCountry: fallbackCountry,
      input: { imageMediaType: image.mediaType, imageBase64: image.base64, country, ...(lang === "sv" ? { lang } : {}) },
      currency,
      deviceId: readDeviceId(body["deviceId"]),
      lang,
    },
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Waits for the Brain, but never longer than the hard limit. */
async function withinHardLimit(work: Promise<BrainRun>, ms: number): Promise<BrainRun | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRequest(req: Request, ctx: HandlerContext): Promise<Response> {
  const started = ctx.deps.now();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return reply(405, { error: T(earlyLang(req)).errors.usePost });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return reply(400, { error: T(earlyLang(req)).errors.invalid });
  }
  if (text.length > MAX_BODY_CHARS) return reply(413, { error: T(earlyLang(req, text)).errors.tooLarge });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return reply(400, { error: T(earlyLang(req, text)).errors.invalid });
  }
  const parsed = parseRequest(raw, headerCountry(req));
  if ("error" in parsed) return reply(400, { error: parsed.error });
  const { input, currency, deviceId, lang, countrySource, ipCountry } = parsed.req; // countrySource: stats only, never shown to the user
  // Owner order 1p: device country first, then device language region, then IP country, USD silently only if nothing at all.
  // The mismatch line below is for the owner's statistics and evaluation ONLY. Nothing about it is ever shown to the user.
  if (ipCountry && input.country && ipCountry !== input.country && countrySource !== "ip") {
    console.log(JSON.stringify({ evt: "country_mismatch", device: input.country, ip: ipCountry, currency }));
  }
  const msg = T(lang).errors;

  let cfg: BrainConfig;
  try {
    cfg = ctx.getConfig();
  } catch (e) {
    ctx.deps.log("config error", errorMessage(e));
    return reply(500, { error: msg.notSetUp });
  }

  // ---- Protection: checked before any paid call. Over the limit: reject, no AI cost.
  // The request is written down as an ATTEMPT here (the 60 per hour). It only becomes a counted valuation (the 20, 500
  // and 1,500) after a successful, non-repeat answer, further down.
  const ipHash = await sha256Hex(`${clientIp(req)}:ip`);
  const userHash = deviceId ? await sha256Hex(`${deviceId}:user`) : ipHash;
  let attemptId: number | null = null;
  let authUserId: string | null = null;
  const protectionStart = ctx.deps.now();
  // ---- Plan limits (hard, server side): before the attempt is written and before any paid work. Never trust the client.
  // Fails open like the protection check below: if the database is slow or broken the request goes through and is logged.
  if (ctx.planLimitsEnabled && ctx.store?.planAndUsage) {
    try {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || null;
      const pu = await Promise.race([
        ctx.store.planAndUsage(userHash, token),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PROTECTION_TIMEOUT_MS)),
      ]);
      if (pu) {
        authUserId = pu.userId;
        const lim = checkLimits(pu.plan, pu.usedMonth, pu.usedDay, pu.usedTotal);
        if (!lim.ok) return reply(429, { error: T(lang).errors[lim.code], code: lim.code, plan: lim.plan });
      }
    } catch (e) {
      ctx.deps.log("plan limit check failed", errorMessage(e));
    }
  }
  if (ctx.store) {
    try {
      // The check must be quick: it is inside the 7 s. If the database is slow, let the request through.
      const check = await Promise.race([
        ctx.store.registerAttempt(userHash, ipHash, ctx.limits, authUserId),
        new Promise<AttemptCheck>((resolve) => setTimeout(() => resolve({ verdict: "ok", attemptId: null }), PROTECTION_TIMEOUT_MS)),
      ]);
      if (check.verdict !== "ok") return reply(429, { error: verdictMessage(check.verdict, lang) });
      attemptId = check.attemptId;
    } catch (e) {
      // If the limit check itself breaks we let the request through: the daily cap and the
      // provider-side spending limits are the second line of defence. The error is logged.
      ctx.deps.log("protection check failed", errorMessage(e));
    }
  }
  const protectionMs = ctx.deps.now() - protectionStart;

  // Exchange rates are fetched at the same moment as everything else (cached for an hour).
  const fxPromise = getFxTable(ctx.deps, cfg.fxUrl, ctx.store?.loadFx && ctx.store?.saveFx ? { load: () => ctx.store!.loadFx!(), save: (t) => ctx.store!.saveFx!(t) } : null);
  const imageHash = await sha256Hex(input.imageBase64);

  const store = ctx.store;
  const memory = store
    ? { find: (key: string, maxAgeMs: number) => store.findMemory(key, maxAgeMs), findNeighbours: store.findNeighbours ? (fp: { category: string; brand: string | null; model: string | null }, maxAgeMs: number) => store.findNeighbours!(fp, maxAgeMs) : undefined }
    : null;

  // ---- The Brain, inside the hard limit.
  ctx.deps.log("[Protection]", { protectionMs, preBrainMs: ctx.deps.now() - started });
  let run: BrainRun;
  try {
    const outcome = await withinHardLimit(
      runBrain(input, cfg, ctx.deps, {
        fx: fxPromise,
        memory,
        startedAt: started,
        calibrationK: refreshCalibration(store, started, ctx.deps.log),
        learnedSoldPerSearch: refreshCountryStats(store, started, ctx.deps.log),
        priceOffsets: refreshPriceOffsets(store, started, ctx.deps.log),
        connectorPolicy: refreshConnectorPolicy(store, started, ctx.deps.log),
        localPlan: ctx.localPlan,
      }),
      cfg.answerMs - SEND_MARGIN_MS - (ctx.deps.now() - started),
    );
    if (outcome === "late") {
      ctx.deps.log("brain missed the hard limit");
      return reply(504, { error: msg.tooSlow });
    }
    run = outcome;
  } catch (e) {
    ctx.deps.log("valuation failed", e instanceof StepError ? `${e.message} ${e.detail.join("; ")}` : e);
    if (e instanceof StepError) {
      return reply(502, { error: msg.couldNotValue });
    }
    return reply(500, { error: msg.wentWrong });
  }

  // ---- Saved in Supabase: only NEW valuations (a Memory hit is never saved again).
  // The answer must not wait for the database: the id is made here and the row is written after
  // the answer has gone out, so the Judge can use every millisecond up to the 7 s limit.
  let runId: string | null = run.memoryRunId;
  if (store && run.saveable && run.result.status === "ok") {
    const newId = crypto.randomUUID();
    runId = newId;
    const key = run.fingerprint ? memoryKey(run.fingerprint, lang) : null;
    const elapsedMs = ctx.deps.now() - started;
    const fxNow = await fxPromise;
    ctx.background(
      store
        .saveRun({
          fx: { currency, rate: currency === "USD" ? 1 : fxNow.rates[currency] ?? null, asOf: fxNow.asOf, source: fxNow.source },
          id: newId,
          memoryKey: key,
          fingerprint: run.fingerprint,
          memoryEligible: run.memoryEligible,
          imageHash,
          steps: run.steps,
          result: run.result,
          brainVersion: BRAIN_VERSION,
          elapsedMs,
        })
        .catch((e) => ctx.deps.log("saving the run failed", errorMessage(e))),
    );
  }

  // The learner's log is written after the answer has gone out.
  if (store && run.searchLog.length > 0) {
    const rows = run.searchLog;
    ctx.background(
      store.logSearches(rows).catch((e) => ctx.deps.log("search log failed", errorMessage(e))),
    );
  }

  // The Connector's own log: also after the answer, and a failed write is swallowed (the table may not exist yet).
  if (store && run.connectorLog) {
    const row = { ...run.connectorLog, run_id: runId };
    ctx.background(
      Promise.resolve()
        .then(() => store.logConnector(row))
        .catch((e) => ctx.deps.log("connector log failed", errorMessage(e))),
    );
  }

  // ---- Counting: only a finished valuation counts, and not a repeat. A failed scan ("needs a better photo", a timeout,
  // an error) already left above or stays an uncounted attempt. Memory hits count too: an item first valued by someone
  // else still counts for this device.
  let repeat = false;
  if (store && run.result.status === "ok") {
    const itemKey = run.fingerprint ? memoryKey(run.fingerprint) : null; // no language in it: the same item in any language
    const budget = Math.min(SETTLE_TIMEOUT_MS, cfg.answerMs - SEND_MARGIN_MS - (ctx.deps.now() - started));
    // The check always runs to its end, so the database never ends up without a decision. Only the WAIT is limited.
    const settling = store.settleAttempt(attemptId, userHash, itemKey);
    let answered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = budget >= SETTLE_MIN_MS
        ? await Promise.race([
            settling,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), budget);
            }),
          ])
        : null;
      if (settled) {
        answered = true;
        repeat = settled.repeat === true;
      }
    } catch (e) {
      answered = true; // it failed, it will not come back later
      ctx.deps.log("counting the valuation failed", errorMessage(e));
    } finally {
      clearTimeout(timer);
    }
    if (!answered) {
      // Too slow to wait for: the app is told "not a repeat" and counts it. When the database finally decides, it must agree
      // with what the app was told. A late "new" is already counted by the database. A late "repeat" is counted here as well.
      ctx.background(
        settling
          .then((late) => (late.repeat && attemptId !== null ? store.markCounted(attemptId) : undefined))
          .catch((e) => ctx.deps.log("late count failed", errorMessage(e))),
      );
    }
  }

  // ---- Exchange rates: the last step, every time, also for answers that came from Memory.
  const fx = await fxPromise;
  return reply(200, {
    ok: true,
    cached: run.memoryHit,
    /** True when this device already valued this item in the last 24 hours: it did not count, and the app must not count it. */
    repeat,
    runId,
    refined: true,
    // Localized first, so the ads carry prices in the user's currency. `marketAds` is the whole decision for "Se marknadsdata".
    result: applyMarketAds(localizeResult(run.result, fx, currency, lang), {
      minMatch: cfg.marketMinMatch ?? 0.8,
      minAds: cfg.marketMinAds ?? 2,
      maxAds: cfg.marketMaxAds ?? 3,
    }),
  });
}
