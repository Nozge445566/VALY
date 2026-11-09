import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../handler.ts";
import { DEFAULT_LIMITS } from "../protection.ts";
import {
  FAKE_DATA_URL, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, fakeStore, json, makeDeps, sampleResult, sampleVerdict,
  serperSold, sleepMs, stepOf, streamJudge, storedValuation, testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

const PLAN = {
  ok: true, strategy_version: 2,
  searches: [{ id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" }],
  stop: { sold_prices: 5, max_ms: 2000 },
};

const happy: Route = async (call: Call, signal?: AbortSignal) => {
  if (call.url.includes("anthropic")) {
    const s = stepOf(call);
    if (s === "detail") return claudeReply(SAMPLE_DETAILS);
    if (s === "auth") return claudeReply(SAMPLE_AUTH);
    if (s === "ident") return claudeReply(SAMPLE_IDENT);
    return streamJudge(sampleVerdict(), signal);
  }
  // A Swedish site: local evidence for the Swedish user (US listings would be global evidence, which Memory never keeps).
  if (call.url.includes("serper")) return serperSold(5, 60, "a", "www.tradera.com");
  return json({}, 404);
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://x.test/functions/v1/value-item", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function ctxOf(route: Route, store = fakeStore()) {
  const { deps, calls, clock } = makeDeps(route);
  const bg: Promise<unknown>[] = [];
  return {
    store, calls,
    ctx: { getConfig: () => testConfig(), store, deps, limits: DEFAULT_LIMITS, background: (p: Promise<unknown>) => { bg.push(p); }, localPlan: fakeEngine(PLAN, { calls, clock }) },
    bg,
  };
}

const DEVICE = "device-0123456789abcdef";

describe("Protection (checked before any paid call)", () => {
  it("rejects over the limit with no AI cost at all", async () => {
    const store = fakeStore();
    store.verdict = "user_limit";
    const { ctx, calls } = ctxOf(happy, store);
    const res = await handleRequest(request({ image: FAKE_DATA_URL, deviceId: DEVICE }), ctx);
    assert.equal(res.status, 429);
    assert.equal(calls.filter((c) => c.url.includes("anthropic") || c.url.includes("serper") || c.url.includes("search-ai")).length, 0);
  });

  it("counts per user (device id) and per network address", async () => {
    const { ctx, store } = ctxOf(happy);
    await handleRequest(request({ image: FAKE_DATA_URL, deviceId: DEVICE }, { "x-forwarded-for": "1.2.3.4" }), ctx);
    await handleRequest(request({ image: FAKE_DATA_URL, deviceId: "another-device-0123456789" }, { "x-forwarded-for": "1.2.3.4" }), ctx);
    assert.equal(store.usageCalls.length, 2);
    assert.notEqual(store.usageCalls[0].userHash, store.usageCalls[1].userHash);
    assert.equal(store.usageCalls[0].ipHash, store.usageCalls[1].ipHash);
  });

  it("falls back to the address when there is no device id", async () => {
    const { ctx, store } = ctxOf(happy);
    await handleRequest(request({ image: FAKE_DATA_URL }, { "x-forwarded-for": "9.9.9.9" }), ctx);
    assert.equal(store.usageCalls[0].userHash, store.usageCalls[0].ipHash);
  });

  it("rejects an invalid photo before checking anything", async () => {
    const { ctx, store } = ctxOf(happy);
    const res = await handleRequest(request({ image: "nope" }), ctx);
    assert.equal(res.status, 400);
    assert.equal(store.usageCalls.length, 0);
  });
});

describe("Answer and Saved in Supabase", () => {
  it("answers in the user's currency and saves the NEW valuation", async () => {
    const { ctx, store, bg } = ctxOf(happy);
    const res = await handleRequest(request({ image: FAKE_DATA_URL, currency: "SEK", country: "SE", deviceId: DEVICE }), ctx);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; runId: string; cached: boolean; result: { currency: string; mid: number; status: string } };
    assert.equal(body.ok, true);
    assert.equal(body.cached, false);
    assert.equal(body.result.currency, "SEK");
    assert.ok(body.result.mid > 400, "about 60 USD in SEK");
    assert.match(body.runId, /^[0-9a-f-]{36}$/);
    assert.equal((store.saved[0] as { id: string }).id, body.runId);
    assert.equal(store.saved.length, 1);
    const saved = store.saved[0] as { memoryKey: string; memoryEligible: boolean; result: { currency: string } };
    assert.equal(saved.memoryKey, "m1|seiko|snk809|SE");
    assert.equal(saved.memoryEligible, true);
    assert.equal(saved.result.currency, "USD", "stored in USD, converted on the way out");
    await Promise.all(bg);
    assert.equal(store.logged.length, 1);
    assert.ok(store.logged[0].length >= 1);
  });

  it("does not save a Memory hit again, and converts it with today's rates", async () => {
    const store = fakeStore();
    store.memory.set("m1|seiko|snk809|SE", storedValuation({ runId: "22222222-2222-4222-8222-222222222222" }));
    const { ctx, calls, bg } = ctxOf(happy, store);
    const res = await handleRequest(request({ image: FAKE_DATA_URL, currency: "EUR", country: "SE", deviceId: DEVICE }), ctx);
    const body = (await res.json()) as { cached: boolean; runId: string; result: { currency: string; fromMemory: boolean } };
    assert.equal(body.cached, true);
    assert.equal(body.runId, "22222222-2222-4222-8222-222222222222");
    assert.equal(body.result.currency, "SEK"); // the app sent EUR: ignored, the device country (SE) decides
    assert.equal(body.result.fromMemory, true);
    assert.equal(store.saved.length, 0);
    await Promise.all(bg);
    assert.equal(store.logged.length, 0);
    assert.equal(calls.filter((c) => c.url.includes("serper")).length, 0);
  });

  it("does not save a 'needs a better photo' answer", async () => {
    const route: Route = async (call) =>
      call.url.includes("anthropic") && stepOf(call) === "ident"
        ? claudeReply({ identifiable: false, what_is_it: "", display_name: "", category: "", type: "", confidence: 0, google_queries: [] })
        : call.url.includes("anthropic") ? claudeReply(SAMPLE_DETAILS) : json({});
    const { ctx, store } = ctxOf(route);
    const res = await handleRequest(request({ image: FAKE_DATA_URL, deviceId: DEVICE }), ctx);
    const body = (await res.json()) as { result: { status: string } };
    assert.equal(body.result.status, "needs_photo");
    assert.equal(store.saved.length, 0);
  });

  it("never waits for saving: the answer carries a ready-made id and the row is written after", async () => {
    const { ctx, store, bg } = ctxOf(happy);
    let saved = false;
    store.saveRun = async (run) => {
      await sleepMs(1500);
      saved = true;
      assert.match(run.id, /^[0-9a-f-]{36}$/);
      return run.id;
    };
    const t0 = Date.now();
    const res = await handleRequest(request({ image: FAKE_DATA_URL, deviceId: DEVICE }), ctx);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 1200, "the answer is not held up by the database");
    assert.equal(saved, false);
    assert.match(((await res.json()) as { runId: string }).runId, /^[0-9a-f-]{36}$/);
    await Promise.all(bg);
    assert.equal(saved, true);
  });

  it("a Judge that gives nothing and no data is a needs_photo answer, never a 502", async () => {
    const route: Route = async (call) => {
      if (call.url.includes("anthropic") && (stepOf(call) === "judge")) return json({ error: "x" }, 500);
      return happy(call, undefined);
    };
    const r2: Route = async (call, s) => (call.url.includes("serper") ? json({ organic: [] }) : route(call, s));
    const { ctx } = ctxOf(r2);
    const res = await handleRequest(request({ image: FAKE_DATA_URL, deviceId: DEVICE }), ctx);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { result: { status: string } }).result.status, "needs_photo");
  });

  it("only accepts POST and answers CORS preflight", async () => {
    const { ctx } = ctxOf(happy);
    assert.equal((await handleRequest(new Request("https://x.test", { method: "GET" }), ctx)).status, 405);
    assert.equal((await handleRequest(new Request("https://x.test", { method: "OPTIONS" }), ctx)).status, 204);
  });
});

describe("Calibration k (read at the start, never allowed to delay the answer)", () => {
  const run = async (store = fakeStore()) => {
    const { ctx, bg } = ctxOf(happy, store);
    const res = await handleRequest(request({ image: FAKE_DATA_URL, deviceId: DEVICE, currency: "USD" }), ctx);
    await Promise.all(bg);
    return { res, store };
  };
  const kOfSaved = (store: ReturnType<typeof fakeStore>) =>
    ((store.saved[0] as { steps: { interval: { k: number } } }).steps.interval.k);

  it("uses k = 1 when there is no calibration table", async () => {
    const { res, store } = await run();
    assert.equal(res.status, 200);
    assert.equal(kOfSaved(store), 1);
  });

  it("applies k from the table, through the parent chain (here: global)", async () => {
    const store = fakeStore();
    store.calibration = [{ bucket: "global", k: 1.7 }];
    const { res } = await run(store);
    assert.equal(res.status, 200);
    assert.equal(kOfSaved(store), 1.7);
  });

  it("reads the table once, then serves it from the 10 minute cache", async () => {
    const store = fakeStore();
    store.calibration = [{ bucket: "global", k: 1.2 }];
    await run(store);
    await run(store);
    assert.equal(store.calibrationCalls, 1);
  });

  it("a failing calibration read never breaks the answer (k = 1)", async () => {
    const store = fakeStore();
    store.loadCalibration = async () => { throw new Error("db down"); };
    const { res } = await run(store);
    assert.equal(res.status, 200);
    assert.equal(kOfSaved(store), 1);
  });

  it("a calibration read that never answers does not delay the answer", async () => {
    const store = fakeStore();
    store.loadCalibration = () => new Promise(() => undefined);
    const t0 = Date.now();
    const { res } = await run(store);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 3000, "answered without waiting for the calibration");
    assert.equal(kOfSaved(store), 1);
  });
});
