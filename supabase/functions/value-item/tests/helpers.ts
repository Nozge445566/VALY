// Shared helpers for the tests: a fake network, fake Supabase store, and sample data.
// Nothing here touches the real network or costs anything.

import { FALLBACK_RATES, resetFxMemo } from "../fx.ts";
import { BRAIN_VERSION, loadConfig } from "../config.ts";
import type { BrainConfig, Deps } from "../config.ts";
import type { LocalPlanFn } from "../search-ai.ts";
import type { Store } from "../store.ts";
import type { StoredValuation } from "../memory.ts";
import type { CountryStat } from "../market-tiers.ts";
import type { OffsetRow } from "../../_shared/offsets.ts";
import { REPEAT_WINDOW_MS } from "../protection.ts";
import type { Limits, UsageVerdict } from "../protection.ts";
import type { BrainResult, ConnectorLogRow, DetailReport, Identification, JudgeVerdict, SearchLogRow } from "../types.ts";
import { HARD_CAPS } from "../config.ts";

/** A tiny valid-looking JPEG header, long enough to pass the image checks. */
export const FAKE_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]).toString("base64");
export const FAKE_DATA_URL = `data:image/jpeg;base64,${FAKE_JPEG_B64}`;

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

export interface Call {
  url: string;
  body: Record<string, unknown> | null;
  at: number;
}

export type Route = (call: Call, signal: AbortSignal | undefined) => Promise<Response> | Response;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function claudeReply(obj: unknown): Response {
  return json({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } });
}

export function fxReply(): Response {
  return json({ result: "success", base_code: "USD", time_last_update_unix: 1_790_000_000, rates: FALLBACK_RATES });
}

export function makeDeps(route: Route): { deps: Deps; calls: Call[]; clock: () => number } {
  const calls: Call[] = [];
  const t0 = Date.now();
  const deps: Deps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      const call: Call = { url, body, at: Date.now() - t0 };
      calls.push(call);
      if (url.includes("open.er-api.com") || url.includes("frankfurter")) return fxReply();
      return await route(call, init?.signal ?? undefined);
    }) as typeof fetch,
    now: () => Date.now(),
    sleep: (ms) => sleepMs(ms),
    log: () => undefined,
  };
  resetFxMemo();
  return { deps, calls, clock: () => Date.now() - t0 };
}

/** Where a fake Search AI engine writes itself down, in the same list and on the same clock as the network calls. */
export interface EngineLog {
  calls: Call[];
  clock: () => number;
}

/**
 * A fake Search AI engine (it replaces the in-process engine, so no test reads the environment or the database).
 * It answers with `answer` (an object, or a function that makes one or throws) and, when given a log, writes itself
 * into `log.calls` as `in-process://search-ai/plan`, so a test can check the order of the steps like for a network call.
 */
export function fakeEngine(answer: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>), log?: EngineLog): LocalPlanFn {
  return async (fingerprint, queries) => {
    log?.calls.push({ url: "in-process://search-ai/plan", body: { fingerprint, queries }, at: log.clock() });
    return typeof answer === "function" ? await answer() : answer;
  };
}

/** A fake Search AI engine that has nothing to offer yet (the fixed templates take over). */
export const noPlanData = (log?: EngineLog): LocalPlanFn => fakeEngine({ ok: false, reason: "no_data" }, log);

export function testConfig(over: Partial<BrainConfig> = {}): BrainConfig {
  const base = loadConfig((k) =>
    ({ ANTHROPIC_API_KEY: "test-key", SERPER_API_KEY: "serper-key" } as Record<string, string>)[k]
  );
  return { ...base, ...over };
}

/** Which step of the Brain a Claude call belongs to, read from its system prompt. */
export function stepOf(call: Call): "detail" | "ident" | "judge" | "secondLook" | "auth" | "other" {
  const system = String(call.body?.system ?? "");
  if (system.includes("You are the Detail eye")) return "detail";
  if (system.includes("You are Identification")) return "ident";
  if (system.includes("You are the Judge")) return "judge";
  if (system.includes("You are the Authenticity eye")) return "auth";
  if (system.includes("You are Second Look")) return "secondLook";
  return "other";
}

export const SAMPLE_IDENT: Identification = {
  identifiable: true,
  what_is_it: "A Seiko 5 automatic wristwatch",
  display_name: "Seiko 5 automatic watch",
  category: "watch",
  type: "automatic wristwatch",
  brand: "Seiko",
  model: "SNK809",
  era: "2010s",
  origin_country: "JP",
  confidence: 88,
  google_queries: ["seiko snk809 sold ebay", "seiko snk809 såld", "seiko snk809 chrono24"],
};

export const SAMPLE_DETAILS: DetailReport = {
  details: [{ kind: "logo", text: "Seiko 5 logo on the dial" }, { kind: "seam", text: "Steel bracelet, light scratches" }],
  condition: { grade: "good", details: "light wear on the case" },
  authenticity_signals: [],
};

export function sampleVerdict(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    identifiable: true,
    display_name: "Seiko 5 SNK809",
    category: "watch",
    brand: "Seiko",
    model: "SNK809",
    condition: { grade: "good", details: "light wear" },
    same: [1, 2, 3, 4, 5],
    similar: [],
    price: { low: 45, mid: 60, high: 80 },
    confidence: 82,
    authenticity_risk: "low",
    authenticity_note: "",
    unknowns: [],
    extra_photo_request: null,
    reason: "Five sold prices agree.",
    ...over,
  };
}

/** A Serper reply with n sold listings, priced around `base` dollars. */
export function serperSold(n: number, base = 60, tag = "a", host = "www.ebay.com"): Response {
  const organic = Array.from({ length: n }, (_, i) => ({
    title: `Seiko 5 SNK809 automatic watch ${tag}${i}`,
    link: `https://${host}/itm/${tag}${i}`,
    snippet: `Sold  Oct ${i + 1}, 2026  US $${base + i}.00`,
  }));
  return json({ organic });
}

export function sampleResult(over: Partial<BrainResult> = {}): BrainResult {
  return {
    status: "ok",
    phase: "verified",
    itemName: "Seiko 5 SNK809",
    category: "watch",
    brand: "Seiko",
    model: "SNK809",
    condition: "good",
    conditionScore: 0.65,
    currency: "USD",
    low: 45,
    mid: 60,
    high: 80,
    confidenceScore: 80,
    confidence: "high",
    needsMoreInfo: null,
    factors: [{ label: "Item", detail: "A watch." }],
    comparables: [],
    degraded: [],
    authenticityFlag: "none",
    fromMemory: false,
    ...over,
  };
}

/**
 * A saved valuation that passes every Memory rule for the sample item in Sweden: made by this Brain version, local
 * evidence, three or more listings, narrow range, confident, no fake signs, in "good" condition, saved just now.
 */
export function storedValuation(over: Partial<StoredValuation> = {}, resultOver: Partial<BrainResult> = {}): StoredValuation {
  const comp = (i: number, kind: "sold" | "asking") => ({
    title: `Seiko 5 SNK809 automatic watch ${i}`, kind, url: `https://www.tradera.com/item/${i}`, price: 58 + i, origin: "SE", tier: "local" as const,
  });
  return {
    runId: "run-1",
    createdAt: new Date().toISOString(),
    memoryEligible: true,
    brainVersion: BRAIN_VERSION,
    result: sampleResult({
      confidenceScore: 80,
      market: { country: "SE", basis: "local", local: 5, regional: 0, global: 0 },
      comparables: [comp(1, "sold"), comp(2, "sold"), comp(3, "sold"), comp(4, "asking")],
      factors: [
        { label: "Item", detail: "Seiko 5 SNK809. Likely Seiko SNK809." },
        { label: "Condition", detail: "Good. old photo wear." },
        { label: "Details", detail: "old photo detail." },
        { label: "Market", detail: "4 of 5 matched." },
      ],
      ...resultOver,
    }),
    ...over,
  };
}

export interface FakeStore extends Store {
  saved: unknown[];
  logged: SearchLogRow[][];
  usageCalls: { userHash: string; ipHash: string }[];
  /** Every call of settleAttempt, in order. */
  settleCalls: { attemptId: number | null; userHash: string; itemKey: string | null }[];
  /** Attempt ids that became counted valuations. */
  counted: number[];
  /** First valuation time per "device|item", like l_device_items. */
  firstValued: Map<string, number>;
  /** The fake database clock, in ms. Tests move it to test the rolling 24 hours. */
  clockMs: number;
  memory: Map<string, StoredValuation>;
  verdict: UsageVerdict;
  calibration: { bucket: string; k: number }[];
  calibrationCalls: number;
  countryStats: CountryStat[];
  countryStatsCalls: number;
  priceOffsets: OffsetRow[];
  priceOffsetsCalls: number;
  connectorLogged: ConnectorLogRow[];
  connectorPolicy: { bucket: string; dial: number }[];
  connectorPolicyCalls: number;
  /** Makes logConnector fail, to prove an answer never depends on it. */
  connectorLogFails: boolean;
}

export function fakeStore(): FakeStore {
  const s: FakeStore = {
    saved: [],
    logged: [],
    usageCalls: [],
    settleCalls: [],
    counted: [],
    firstValued: new Map(),
    clockMs: Date.parse("2026-11-04T12:00:00Z"),
    memory: new Map(),
    verdict: "ok",
    calibration: [],
    calibrationCalls: 0,
    countryStats: [],
    countryStatsCalls: 0,
    priceOffsets: [],
    priceOffsetsCalls: 0,
    connectorLogged: [],
    connectorPolicy: [],
    connectorPolicyCalls: 0,
    connectorLogFails: false,
    async logConnector(row) {
      if (s.connectorLogFails) throw new Error("relation l_connector_log does not exist");
      s.connectorLogged.push(row);
    },
    async loadConnectorPolicy() {
      s.connectorPolicyCalls += 1;
      return s.connectorPolicy;
    },
    async loadPriceOffsets() {
      s.priceOffsetsCalls += 1;
      return s.priceOffsets;
    },
    async loadCountryStats() {
      s.countryStatsCalls += 1;
      return s.countryStats;
    },
    async loadCalibration() {
      s.calibrationCalls += 1;
      return s.calibration;
    },
    async findMemory(key) {
      const one = s.memory.get(key);
      return one ? [one] : [];
    },
    async registerAttempt(userHash: string, ipHash: string, _limits: Limits) {
      s.usageCalls.push({ userHash, ipHash });
      return { verdict: s.verdict, attemptId: s.verdict === "ok" ? s.usageCalls.length : null };
    },
    // Mirrors the SQL function l_settle_attempt: the first valuation of an item starts 24 rolling hours, a repeat inside them
    // does not move the start, and after them the item counts like a new one.
    async settleAttempt(attemptId: number | null, userHash: string, itemKey: string | null) {
      s.settleCalls.push({ attemptId, userHash, itemKey });
      let repeat = false;
      if (itemKey !== null) {
        const k = `${userHash}|${itemKey}`;
        const first = s.firstValued.get(k);
        if (first !== undefined && s.clockMs - first < REPEAT_WINDOW_MS) repeat = true;
        else s.firstValued.set(k, s.clockMs);
      }
      if (!repeat && attemptId !== null) s.counted.push(attemptId);
      return { repeat };
    },
    async markCounted(attemptId: number) {
      if (!s.counted.includes(attemptId)) s.counted.push(attemptId);
    },
    async saveRun(run) {
      s.saved.push(run);
      return "11111111-1111-4111-8111-111111111111";
    },
    async logSearches(rows) {
      s.logged.push(rows);
    },
  };
  return s;
}

export const TARGET = HARD_CAPS.soldPrices;

// ---------------------------------------------------------------- streamed Judge answers

/** The Judge's fields in the order its prompt asks for them. */
export function judgeJson(v: JudgeVerdict): string {
  // The Judge writes LABELS only (no price, no confidence). Ads come from `ads`, else from same / similar.
  const ads = v.ads ?? [
    ...v.same.map((id) => ({ id, match: "same", condition_vs_ad: "equal" })),
    ...v.similar.map((id) => ({ id, match: "similar", condition_vs_ad: "equal" })),
  ];
  return JSON.stringify({
    identifiable: v.identifiable, ads, authenticity_risk: v.authenticity_risk, condition: v.condition,
    eye_text_mismatch: v.eye_text_mismatch ?? [], brand: v.brand, model: v.model,
    category: v.category, display_name: v.display_name, unknowns: v.unknowns,
    extra_photo_request: v.extra_photo_request, reason: v.reason,
  });
}

/** A sample Authenticity eye answer (eye 3). */
export const SAMPLE_AUTH = {
  signs: [{ kind: "construction", text: "Case and bracelet finish consistent with the era" }],
  era: "2010s",
  risk_hint: "low",
  search_terms: [],
};

export interface StreamOptions {
  /** Pause before each piece of text, in ms. */
  delayMs?: number;
  /** Number of pieces the text is cut into. */
  pieces?: number;
  /** Send only this many characters, then go quiet (the model is "still thinking"). */
  stopAfterChars?: number;
  /** Send a thinking block (index 0) with this many characters before the text block (index 1), and close it. */
  thinkingChars?: number;
}

/** A server-sent-events answer like Anthropic's, with controllable speed. Stops when aborted. */
export function sseResponse(text: string, signal: AbortSignal | undefined, o: StreamOptions = {}): Response {
  const pieces = Math.max(1, o.pieces ?? 4);
  const body = o.stopAfterChars !== undefined ? text.slice(0, o.stopAfterChars) : text;
  const size = Math.ceil(body.length / pieces);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => controller.error(new DOMException("aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const send = (obj: unknown) => controller.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(obj)}\n\n`));
      try {
        send({ type: "message_start", message: { usage: { input_tokens: 5 } } });
        const textIndex = o.thinkingChars ? 1 : 0;
        if (o.thinkingChars) {
          send({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
          send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "t".repeat(o.thinkingChars) } });
          send({ type: "content_block_stop", index: 0 });
          send({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
        }
        for (let i = 0; i < body.length; i += size) {
          if (o.delayMs) await sleepMs(o.delayMs, signal);
          send({ type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: body.slice(i, i + size) } });
        }
        if (o.stopAfterChars !== undefined) await sleepMs(60_000, signal); // goes quiet until cut off
        send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
        send({ type: "message_stop" });
        controller.close();
      } catch {
        // aborted: the error was already sent to the reader
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function streamJudge(v: JudgeVerdict, signal: AbortSignal | undefined, o: StreamOptions = {}): Response {
  return sseResponse(judgeJson(v), signal, o);
}
