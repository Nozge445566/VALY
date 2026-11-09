// What counts toward the limits (20 per device per hour, 500 per network address, 1,500 per day) and what is free.
// Counted: only a valuation that finished successfully and is not a repeat. Not counted: failed scans, repeats within 24 hours.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../handler.ts";
import { DEFAULT_LIMITS, REPEAT_WINDOW_MS, decideVerdict, verdictMessage } from "../protection.ts";
import type { Limits, UsageCounts } from "../protection.ts";
import {
  FAKE_DATA_URL, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, fakeStore, json, makeDeps, sampleVerdict, serperSold,
  sleepMs, stepOf, streamJudge, storedValuation, testConfig,
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
  if (call.url.includes("serper")) return serperSold(5, 60, "a", "www.tradera.com");
  return json({}, 404);
};
const DEVICE = "device-0123456789abcdef";
const OTHER = "another-device-0123456789";
const ITEM = "m1|seiko|snk809|SE";

function request(deviceId = DEVICE, lang?: "sv"): Request {
  return new Request("https://x.test/f", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify({ image: FAKE_DATA_URL, currency: "SEK", country: "SE", deviceId, ...(lang ? { lang } : {}) }),
  });
}
function setup(route: Route = happy, store = fakeStore()) {
  const { deps, calls, clock } = makeDeps(route);
  const bg: Promise<unknown>[] = [];
  const ctx = { getConfig: () => testConfig(), store, deps, limits: DEFAULT_LIMITS, background: (p: Promise<unknown>) => { bg.push(p); }, localPlan: fakeEngine(PLAN, { calls, clock }) };
  return { store, ctx, calls, bg };
}
const scan = async (ctx: ReturnType<typeof setup>["ctx"], deviceId = DEVICE, lang?: "sv") => {
  const res = await handleRequest(request(deviceId, lang), ctx);
  return { res, body: (await res.json()) as { repeat?: boolean; cached?: boolean; result?: { status: string } } };
};

describe("the agreed limits", () => {
  it("are 20 counted and 60 attempts per device per hour, 500 per address per hour, 1,500 per day", () => {
    assert.deepEqual(DEFAULT_LIMITS, { perUserHour: 20, attemptsPerUserHour: 60, perIpHour: 500, perDay: 1500 });
  });

  const none: UsageCounts = { userCounted: 0, userAttempts: 0, ipCounted: 0, dayCounted: 0 };
  const L: Limits = DEFAULT_LIMITS;
  it("decideVerdict: each limit is full at its number and not before", () => {
    assert.equal(decideVerdict(none, L), "ok");
    assert.equal(decideVerdict({ ...none, userCounted: 19 }, L), "ok");
    assert.equal(decideVerdict({ ...none, userCounted: 20 }, L), "user_limit");
    assert.equal(decideVerdict({ ...none, userAttempts: 59 }, L), "ok");
    assert.equal(decideVerdict({ ...none, userAttempts: 60 }, L), "attempt_limit");
    assert.equal(decideVerdict({ ...none, ipCounted: 499 }, L), "ok");
    assert.equal(decideVerdict({ ...none, ipCounted: 500 }, L), "ip_limit");
    assert.equal(decideVerdict({ ...none, dayCounted: 1499 }, L), "ok");
    assert.equal(decideVerdict({ ...none, dayCounted: 1500 }, L), "day_limit");
  });
  it("decideVerdict: attempts alone can never reach the 20, and 60 attempts stop a device that never succeeds", () => {
    assert.equal(decideVerdict({ ...none, userAttempts: 59, userCounted: 0 }, L), "ok");
    assert.equal(decideVerdict({ ...none, userAttempts: 60, userCounted: 0 }, L), "attempt_limit");
  });
  it("the 60 has a message in both languages", () => {
    assert.match(verdictMessage("attempt_limit"), /Please wait/);
    assert.match(verdictMessage("attempt_limit", "sv"), /Vänta/);
  });
});

describe("what counts", () => {
  it("a successful valuation is written as an attempt first, then counted", async () => {
    const { ctx, store } = setup();
    const { res, body } = await scan(ctx);
    assert.equal(res.status, 200);
    assert.equal(body.repeat, false);
    assert.equal(store.usageCalls.length, 1);
    assert.deepEqual(store.settleCalls.map((c) => [c.attemptId, c.itemKey]), [[1, ITEM]]);
    assert.deepEqual(store.counted, [1]);
  });

  it("the item key carries no language: the same item in Swedish and English is the same item", async () => {
    const { ctx, store } = setup();
    await scan(ctx, DEVICE, "sv");
    assert.equal(store.settleCalls[0].itemKey, ITEM);
  });

  it("a rejected request (over a limit) is neither an attempt nor counted, and costs nothing", async () => {
    const store = fakeStore();
    store.verdict = "attempt_limit";
    const { ctx, calls } = setup(happy, store);
    const { res } = await scan(ctx);
    assert.equal(res.status, 429);
    assert.equal(store.settleCalls.length, 0);
    assert.equal(calls.filter((c) => c.url.includes("anthropic") || c.url.includes("serper")).length, 0);
  });

  it("'needs a better photo' does not count", async () => {
    const route: Route = async (call) =>
      call.url.includes("anthropic") && stepOf(call) === "ident"
        ? claudeReply({ identifiable: false, what_is_it: "", display_name: "", category: "", type: "", confidence: 0, google_queries: [] })
        : call.url.includes("anthropic") ? claudeReply(SAMPLE_DETAILS) : json({});
    const { ctx, store } = setup(route);
    const { body } = await scan(ctx);
    assert.equal(body.result?.status, "needs_photo");
    assert.equal(store.usageCalls.length, 1, "it was an attempt (the 60)");
    assert.equal(store.settleCalls.length, 0);
    assert.deepEqual(store.counted, []);
  });

  it("a Judge failure with nothing to go on is a needs_photo answer (200), and does not count", async () => {
    const route: Route = async (call, s) => {
      if (call.url.includes("anthropic") && (stepOf(call) === "judge")) return json({ error: "x" }, 500);
      return call.url.includes("serper") ? json({ organic: [] }) : happy(call, s);
    };
    const { ctx, store } = setup(route);
    const { res } = await scan(ctx);
    assert.equal(res.status, 200);
    assert.equal(store.usageCalls.length, 1);
    assert.equal(store.settleCalls.length, 0);
    assert.deepEqual(store.counted, []);
  });

  it("an item first valued by someone else still counts for this device", async () => {
    const store = fakeStore();
    store.memory.set(ITEM, storedValuation({ runId: "22222222-2222-4222-8222-222222222222" }));
    const { ctx } = setup(happy, store);
    const { body } = await scan(ctx);
    assert.equal(body.cached, true);
    assert.equal(body.repeat, false);
    assert.deepEqual(store.counted, [1]);
  });

  it("a different device scanning the same item counts", async () => {
    const { ctx, store } = setup();
    await scan(ctx, DEVICE);
    const { body } = await scan(ctx, OTHER);
    assert.equal(body.repeat, false);
    assert.equal(store.counted.length, 2);
  });
});

describe("repeats are free for 24 rolling hours", () => {
  const H = 3600 * 1000;

  it("the same device scanning the same item again is a repeat: answered, flagged, not counted", async () => {
    const { ctx, store } = setup();
    const first = await scan(ctx);
    store.clockMs += 6 * H; // Monday 14:00 -> 20:00
    const again = await scan(ctx);
    assert.equal(again.res.status, 200);
    assert.equal(first.body.repeat, false);
    assert.equal(again.body.repeat, true);
    assert.deepEqual(store.counted, [1], "only the first one counted");
    assert.equal(store.usageCalls.length, 2, "both were attempts (the 60)");
  });

  it("still free one minute before the 24 hours are over, counted after them", async () => {
    const { ctx, store } = setup();
    await scan(ctx);
    store.clockMs += REPEAT_WINDOW_MS - 60_000; // Tuesday 13:59
    assert.equal((await scan(ctx)).body.repeat, true);
    store.clockMs += 2 * 60_000; // Tuesday 14:01
    assert.equal((await scan(ctx)).body.repeat, false);
    assert.deepEqual(store.counted, [1, 3]);
  });

  it("a repeat does not restart the window", async () => {
    const { ctx, store } = setup();
    await scan(ctx); // t = 0
    store.clockMs += 20 * H;
    assert.equal((await scan(ctx)).body.repeat, true); // t = 20 h, free
    store.clockMs += 5 * H; // t = 25 h: 24 h after the FIRST valuation, only 5 h after the repeat
    assert.equal((await scan(ctx)).body.repeat, false);
  });

  it("after the window the item counts like a new one and starts a new window", async () => {
    const { ctx, store } = setup();
    await scan(ctx);
    store.clockMs += 25 * H;
    assert.equal((await scan(ctx)).body.repeat, false);
    store.clockMs += 1 * H;
    assert.equal((await scan(ctx)).body.repeat, true, "free inside the new window");
  });

  it("another device does not get the free repeat", async () => {
    const { ctx, store } = setup();
    await scan(ctx, DEVICE);
    store.clockMs += 1 * H;
    assert.equal((await scan(ctx, OTHER)).body.repeat, false);
  });
});

describe("counting never breaks or delays an answer", () => {
  it("a failing count still answers, as not a repeat (the app counts it too)", async () => {
    const store = fakeStore();
    store.settleAttempt = async () => { throw new Error("db down"); };
    const { ctx } = setup(happy, store);
    const { res, body } = await scan(ctx);
    assert.equal(res.status, 200);
    assert.equal(body.repeat, false);
  });

  it("a count that never answers does not hold the answer up", async () => {
    const store = fakeStore();
    store.settleAttempt = () => new Promise(() => undefined);
    const { ctx } = setup(happy, store);
    const t0 = Date.now();
    const { res, body } = await scan(ctx);
    assert.equal(res.status, 200);
    assert.equal(body.repeat, false);
    assert.ok(Date.now() - t0 < 2500, "answered without waiting for the count");
  });

  it("a late 'repeat' is counted on the server, so it matches what the app was told", async () => {
    const { ctx, store, bg } = setup();
    await scan(ctx); // first valuation: attempt 1 counted
    const real = store.settleAttempt.bind(store);
    store.settleAttempt = async (...a) => { await sleepMs(700); return real(...a); }; // slower than the wait
    const { body } = await scan(ctx); // the same item again: really a repeat
    assert.equal(body.repeat, false, "the app was told: counts");
    await Promise.all(bg);
    assert.deepEqual(store.counted, [1, 2], "the server counts it too");
  });

  it("a late 'new' needs no correction", async () => {
    const { ctx, store, bg } = setup();
    const real = store.settleAttempt.bind(store);
    store.settleAttempt = async (...a) => { await sleepMs(700); return real(...a); };
    await scan(ctx);
    await Promise.all(bg);
    assert.deepEqual(store.counted, [1]);
  });

  it("a count that was too slow to even wait for still ends consistent", async () => {
    const { ctx, store, bg } = setup();
    await scan(ctx);
    // Not enough time left before the hard limit: the answer goes out without waiting.
    ctx.getConfig = () => testConfig({ answerMs: 100 });
    const { body } = await scan(ctx);
    assert.notEqual(body.repeat, true); // too little time: no answer is made at all now (no Scout photo-only fallback), never a wrong repeat flag
    await Promise.all(bg);
    assert.deepEqual(store.counted, [1]); // the 100 ms scan made no answer (Scout photo-only fallback is gone), and an answer that was never made is never counted
  });

  it("without a database the answer carries repeat: false", async () => {
    const { deps, calls, clock } = makeDeps(happy);
    const ctx = { getConfig: () => testConfig(), store: null, deps, limits: DEFAULT_LIMITS, background: () => undefined, localPlan: fakeEngine(PLAN, { calls, clock }) };
    const res = await handleRequest(request(), ctx);
    assert.equal(((await res.json()) as { repeat: boolean }).repeat, false);
  });
});
