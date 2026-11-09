// The app's valuation lives in "the valuation engine", a Supabase Edge Function (supabase/functions/value-item).
// This file only talks to the valuation engine and turns its answers into what the screens expect.
// No AI key is ever used in the browser, and no money is converted here: the valuation engine converts
// with live exchange rates and sends finished amounts in the user's currency.
//
// One request: photo in, finished estimate out. The valuation engine answers within 7 seconds.

import type { Condition } from "./catalog";
import { detectCurrency } from "./currency";
import { currentLang } from "./i18n";
import { TEXTS } from "./texts";
import { cleanCountry, readMarket, readTier, type MarketInfo, type Tier } from "./market";

export interface ComparableListing {
  title: string;
  kind: "sold" | "asking" | "unknown";
  url: string;
  price: number;
  /** Country of the listing (ISO alpha-2) and how well it speaks for the user's country. Missing on old results. */
  origin?: string;
  tier?: Tier;
  /** 0..1: how well the ad matches the item. Missing on old results. */
  match?: number;
}

/** What the valuation engine knows about the item that the written explanation may use. null = unknown. */
export interface ExplainFacts {
  era: string | null;
  origin: string | null;
  material: string | null;
  /** 0-100 */
  identConfidence: number | null;
  antique: boolean;
  highValueOrAntique: boolean;
}

export interface ValuationResult {
  low: number;
  mid: number;
  high: number;
  confidence: "low" | "medium" | "high";
  /** 0-100. Used for logic only. The screen shows the label, never this number. */
  confidenceScore: number;
  /** Share of similar sales the range is meant to hold. Only set by newer engine versions (0.8). */
  intervalLevel: 0.8 | null;
  /** Short codes for what makes the range wide (at most two). Empty for older results. */
  widthDrivers: string[];
  detectedCondition: Condition;
  conditionScore: number;
  recognizedBrand: string;
  factors: { label: string; detail: string }[];
  /** What the valuation engine decided the item is. */
  itemName: string;
  /** Free-text label from the valuation engine. Not a fixed category. */
  category: string;
  /** A specific extra photo that would make the estimate better. Never required. */
  needsMoreInfo: string | null;
  comparables: ComparableListing[];
  /** Always the finished answer. Older cached rows may still say "quick". */
  phase: "quick" | "verified";
  /** Currency of every amount in this result. */
  currency: string;
  /** The market this price was made for and where its evidence came from. null on old results. */
  market: MarketInfo | null;
  /** Ads that passed the server's match bar (see supabase/functions/value-item/market-ads.ts). Empty on old results. */
  marketAds: ComparableListing[];
  /** How many ads the server asks for before "Se marknadsdata" shows. */
  minAds: number;
  /** Facts for "Så värderade vi". null on old results and Memory answers. */
  explain: ExplainFacts | null;
}

export interface EstimateReply {
  result: ValuationResult;
  /** Id of the stored run. Needed to send back the real price. */
  runId: string | null;
  /**
   * True when the server says this device already valued this item in the last 24 hours. A repeat is free: it must not use
   * up one of the user's 15. False when the server says nothing (an older server): then it counts, as before.
   */
  repeat: boolean;
}

const FUNCTION_NAME = "value-item";
/** The server answers within 7 s (hard limit). Margin for the network and a cold start. */
const ESTIMATE_TIMEOUT_MS = 12_000;

const DEVICE_KEY = "valy_device_id";

/**
 * An anonymous id for this device, made once. The valuation engine uses it for "40 valuations per hour per
 * user" (Protection). It is not a login and holds no personal data. Only a hash is stored.
 */
function getDeviceId(): string | undefined {
  try {
    const ok = (v: string | null): v is string => v !== null && /^[A-Za-z0-9-]{16,64}$/.test(v);
    let id = localStorage.getItem(DEVICE_KEY);
    if (!ok(id)) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return undefined; // private mode: the valuation engine falls back to the network address
  }
}

const CONDITIONS: readonly Condition[] = ["new", "like-new", "good", "fair", "poor"];

interface ServerResult {
  status?: unknown;
  phase?: unknown;
  itemName?: unknown;
  category?: unknown;
  brand?: unknown;
  condition?: unknown;
  conditionScore?: unknown;
  currency?: unknown;
  low?: unknown;
  mid?: unknown;
  high?: unknown;
  confidenceScore?: unknown;
  confidence?: unknown;
  intervalLevel?: unknown;
  widthDrivers?: unknown;
  needsMoreInfo?: unknown;
  factors?: unknown;
  comparables?: unknown;
  market?: unknown;
  marketAds?: unknown;
  minAds?: unknown;
  explain?: unknown;
}

interface ServerReply {
  error?: unknown;
  runId?: unknown;
  repeat?: unknown;
  result?: ServerResult;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Older saved valuations have no widthDrivers. Anything that is not a short string is dropped. */
function readDrivers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((d): d is string => typeof d === "string" && /^[a-z_]{1,40}$/.test(d)).slice(0, 2);
}

function readFactors(v: unknown): { label: string; detail: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { label: string; detail: string }[] = [];
  for (const f of v) {
    if (typeof f === "object" && f !== null) {
      const { label, detail } = f as { label?: unknown; detail?: unknown };
      if (typeof label === "string" && typeof detail === "string") out.push({ label, detail });
    }
  }
  return out;
}

/** An older engine still sends English labels: show them in the phone's language. The new engine already writes in it. */
function translateLabel(f: { label: string; detail: string }): { label: string; detail: string } {
  const mapped = TEXTS.factorLabels[f.label];
  return mapped ? { ...f, label: mapped } : f;
}

function readComparables(v: unknown): ComparableListing[] {
  if (!Array.isArray(v)) return [];
  const out: ComparableListing[] = [];
  for (const c of v) {
    if (typeof c !== "object" || c === null) continue;
    const { title, kind, url, price, origin, tier, match } = c as {
      title?: unknown; kind?: unknown; url?: unknown; price?: unknown; origin?: unknown; tier?: unknown; match?: unknown;
    };
    if (typeof title !== "string" || typeof url !== "string" || !isNum(price)) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    const item: ComparableListing = { title, url, price, kind: kind === "sold" || kind === "asking" ? kind : "unknown" };
    const o = cleanCountry(origin);
    const t = readTier(tier);
    if (o) item.origin = o;
    if (t) item.tier = t;
    if (isNum(match) && match >= 0 && match <= 1) item.match = match;
    out.push(item);
  }
  return out;
}

function readExplain(v: unknown): ExplainFacts | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 60) : null);
  return {
    era: text(e.era),
    origin: text(e.origin),
    material: text(e.material),
    identConfidence: isNum(e.identConfidence) ? Math.max(0, Math.min(100, e.identConfidence)) : null,
    antique: e.antique === true,
    highValueOrAntique: e.highValueOrAntique === true,
  };
}

/**
 * The signed-in user's access token, so the server can tell who is asking (plan and usage). Falls back to the anon key,
 * which is what the server sees for anyone it cannot identify (then the request counts as Free).
 */
async function bearerToken(anonKey: string): Promise<string> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? anonKey;
  } catch {
    return anonKey;
  }
}

/** Sends one request to the valuation engine. Throws an Error with a message that is fit to show the user. */
async function callL(body: Record<string, unknown>, timeoutMs: number, timeoutMessage: string): Promise<ServerReply> {
  const baseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!baseUrl || !anonKey) {
    throw new Error(TEXTS.errors.notConnected);
  }

  const currency = detectCurrency();
  const token = await bearerToken(anonKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/+$/, "")}/functions/v1/${FUNCTION_NAME}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...body,
          locale: currency.locale,
          // The language of the words the valuation engine writes (item name, notes, photo tips). Decided by the phone.
          lang: currentLang(),
          country: currency.country ?? undefined,
          deviceId: getDeviceId(),
        }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw new Error(timeoutMessage);
      throw new Error(TEXTS.errors.unreachable);
    }

    const data = (await res.json().catch(() => null)) as ServerReply | null;
    if (!res.ok) {
      const code = (data as { code?: unknown } | null)?.code;
      if (code === "limit_total" || code === "limit_month" || code === "limit_day") throw new PlanLimitError(code, String(data?.error ?? ""));
      throw new Error(data && typeof data.error === "string" ? data.error : TEXTS.errors.failedStatus(res.status));
    }
    if (!data?.result) throw new Error(TEXTS.errors.unexpected);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Turns the engine's answer into a ValuationResult. Returns null when the valuation engine asks for a better photo. */
function toResult(data: ServerReply): { result: ValuationResult | null; needsPhoto: string | null } {
  const r = data.result as ServerResult;
  if (r.status === "needs_photo") {
    return {
      result: null,
      needsPhoto:
        typeof r.needsMoreInfo === "string" && r.needsMoreInfo
          ? r.needsMoreInfo
          : TEXTS.errors.needsPhoto,
    };
  }
  if (!isNum(r.low) || !isNum(r.mid) || !isNum(r.high) || typeof r.itemName !== "string") {
    throw new Error(TEXTS.errors.unexpected);
  }
  const condition = CONDITIONS.find((c) => c === r.condition) ?? "good";
  const confidence = r.confidence === "high" || r.confidence === "medium" ? r.confidence : "low";
  return {
    needsPhoto: null,
    result: {
      low: r.low,
      mid: r.mid,
      high: r.high,
      confidence,
      confidenceScore: isNum(r.confidenceScore) ? r.confidenceScore : 0,
      intervalLevel: r.intervalLevel === 0.8 ? 0.8 : null,
      widthDrivers: readDrivers(r.widthDrivers),
      detectedCondition: condition,
      conditionScore: isNum(r.conditionScore) ? r.conditionScore : 0.65,
      recognizedBrand: typeof r.brand === "string" ? r.brand : "",
      factors: readFactors(r.factors).map(translateLabel),
      itemName: r.itemName,
      category: typeof r.category === "string" && r.category ? r.category : "Other",
      needsMoreInfo: typeof r.needsMoreInfo === "string" && r.needsMoreInfo ? r.needsMoreInfo : null,
      comparables: readComparables(r.comparables),
      phase: r.phase === "quick" ? "quick" : "verified",
      currency: typeof r.currency === "string" ? r.currency : detectCurrency().code,
      market: readMarket(r.market),
      marketAds: readComparables(r.marketAds).slice(0, 3),
      minAds: isNum(r.minAds) && r.minAds >= 1 ? Math.floor(r.minAds) : 2,
      explain: readExplain(r.explain),
    },
  };
}

/** The valuation engine could not value the item and asks for a better photo. A calm screen, not an error banner. */
export class NeedsPhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsPhotoError";
  }
}

/** One shot: a finished estimate from the photo alone. */
export async function estimate(imageDataUrl: string): Promise<EstimateReply> {
  const data = await callL(
    { image: imageDataUrl },
    ESTIMATE_TIMEOUT_MS,
    TEXTS.errors.tooSlow,
  );
  const { result, needsPhoto } = toResult(data);
  if (!result) throw new NeedsPhotoError(needsPhoto ?? TEXTS.errors.tryClearer);
  return {
    result,
    runId: typeof data.runId === "string" ? data.runId : null,
    repeat: data.repeat === true,
  };
}

/** The server refused because the plan's monthly or daily scan limit is used. Not an error banner: the app shows the plans path. */
export class PlanLimitError extends Error {
  constructor(public code: "limit_total" | "limit_month" | "limit_day", message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}
