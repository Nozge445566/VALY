import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callClaudeStream } from "../claude.ts";
import { AbortedError } from "../http.ts";
import { judge, JUDGE_THINKING_MAX_TOKENS } from "../judge.ts";
import { judgeEffortOf } from "../config.ts";
import { parseTruncatedObject } from "../json.ts";
import { StepError } from "../types.ts";
import { validateJudge } from "../validate.ts";
import { handleRequest } from "../handler.ts";
import { DEFAULT_LIMITS } from "../protection.ts";
import {
  FAKE_DATA_URL, FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, fakeStore, json, judgeJson, makeDeps,
  sampleVerdict, serperSold, sleepMs, sseResponse, stepOf, streamJudge, testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

describe("parseTruncatedObject", () => {
  it("reads a finished object", () => {
    assert.deepEqual(parseTruncatedObject('text {"a":1,"b":{"c":2}} more'), { a: 1, b: { c: 2 } });
  });
  it("keeps the finished fields of a cut-off object and drops the half-written one", () => {
    assert.deepEqual(parseTruncatedObject('{"a":1,"b":{"c":2},"d":"half writ'), { a: 1, b: { c: 2 } });
    assert.deepEqual(parseTruncatedObject('{"a":1,"price":{"low":4,"mid":5,"high":6},"conf'), { a: 1, price: { low: 4, mid: 5, high: 6 } });
  });
  it("never mistakes an object inside an unfinished object for the answer", () => {
    const got = parseTruncatedObject('{"identifiable":true,"price":{"low":4,"mid":5,"high":6},"confidence":8');
    assert.ok(got && "identifiable" in got);
  });
  it("keeps a nested value that just closed even before its comma arrives", () => {
    assert.deepEqual(parseTruncatedObject('{"a":1,"price":{"low":4,"mid":5,"high":6}'), { a: 1, price: { low: 4, mid: 5, high: 6 } });
    assert.deepEqual(parseTruncatedObject('{"same":[1,2]'), { same: [1, 2] });
  });
  it("gives up when no field is finished", () => {
    assert.equal(parseTruncatedObject('{"identifiable":tr'), null);
    assert.equal(parseTruncatedObject("no json at all"), null);
  });
  it("handles commas and braces inside strings", () => {
    assert.deepEqual(parseTruncatedObject('{"a":"x, {y}","b":2,"c":"un'), { a: "x, {y}", b: 2 });
  });
});

describe("validateJudge in partial mode", () => {
  it("accepts the essentials and reports what is missing", () => {
    const v = validateJudge({ identifiable: true, same: [1, 2], price: { low: 40, mid: 50, high: 70 } }, 5, true);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.value.confidence, 40);
      assert.deepEqual(v.value.same, [1, 2]);
      assert.ok(v.value.missing?.includes("confidence"));
      assert.ok(v.value.missing?.includes("display_name"));
    }
  });
  it("still needs a price", () => {
    assert.equal(validateJudge({ identifiable: true, same: [1] }, 5, true).ok, false);
  });
  it("is strict when not partial", () => {
    assert.equal(validateJudge({ identifiable: true, same: [1], price: { low: 40, mid: 50, high: 70 } }, 5).ok, false);
  });
});

const baseReq = { model: "m", system: "s", content: [], maxTokens: 100, temperature: 0.1 };

describe("callClaudeStream", () => {
  it("builds the answer from the stream", async () => {
    const { deps } = makeDeps((_c, signal) => sseResponse("hello world", signal, { pieces: 3 }));
    const r = await callClaudeStream(deps, testConfig(), { ...baseReq, timeoutMs: 2000 });
    assert.equal(r.text, "hello world");
    assert.equal(r.complete, true);
    assert.equal(r.outputTokens, 20);
  });

  it("traces when thinking started and when the thinking block was closed", async () => {
    const { deps } = makeDeps((_c, signal) => sseResponse("answer", signal, { pieces: 1, thinkingChars: 12 }));
    const r = await callClaudeStream(deps, testConfig(), { ...baseReq, timeoutMs: 2000 });
    assert.equal(r.text, "answer");
    assert.equal(r.trace?.thinkingChars, 12);
    assert.ok(r.trace?.thinkingStartMs !== null && r.trace?.thinkingEndMs !== null, JSON.stringify(r.trace));
    assert.ok((r.trace?.thinkingEndMs as number) >= (r.trace?.thinkingStartMs as number));
    assert.ok((r.trace?.firstTextMs as number) >= (r.trace?.thinkingEndMs as number));
  });

  it("thinkingEndMs is null when no thinking block was ever closed", async () => {
    const { deps } = makeDeps((_c, signal) => sseResponse("answer", signal, { pieces: 1 }));
    const r = await callClaudeStream(deps, testConfig(), { ...baseReq, timeoutMs: 2000 });
    assert.equal(r.trace?.thinkingEndMs, null);
  });

  it("stops at the deadline and returns what was written so far", async () => {
    const { deps } = makeDeps((_c, signal) => sseResponse("abcdefghij", signal, { stopAfterChars: 5, pieces: 1 }));
    const t0 = Date.now();
    const r = await callClaudeStream(deps, testConfig(), { ...baseReq, timeoutMs: 400 });
    assert.equal(r.complete, false);
    assert.equal(r.text, "abcde");
    const took = Date.now() - t0;
    assert.ok(took >= 380 && took < 700, `took ${took}`);
  });

  it("returns an empty cut-off answer when nothing arrived in time", async () => {
    const { deps } = makeDeps((_c, signal) => sseResponse("x", signal, { delayMs: 5000, pieces: 1 }));
    const r = await callClaudeStream(deps, testConfig(), { ...baseReq, timeoutMs: 300 });
    assert.equal(r.complete, false);
    assert.equal(r.text, "");
  });

  it("throws on an HTTP error and on a cancel from outside", async () => {
    const a = makeDeps(() => json({ error: "x" }, 529));
    await assert.rejects(callClaudeStream(a.deps, testConfig(), { ...baseReq, timeoutMs: 1000 }), /529/);
    const ctl = new AbortController();
    const b = makeDeps((_c, signal) => sseResponse("x", signal, { delayMs: 5000, pieces: 1 }));
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(callClaudeStream(b.deps, testConfig(), { ...baseReq, timeoutMs: 3000, signal: ctl.signal }), AbortedError);
  });

  it("retries once without temperature, only before the stream starts", async () => {
    let n = 0;
    const { deps } = makeDeps((c, signal) => {
      n++;
      if ("temperature" in (c.body ?? {})) return json({ error: { message: "temperature unsupported" } }, 400);
      return sseResponse("ok", signal, { pieces: 1 });
    });
    const r = await callClaudeStream(deps, testConfig(), { ...baseReq, model: "stream-model-x", timeoutMs: 1000 });
    assert.equal(r.text, "ok");
    assert.equal(n, 2);
  });
});

const input = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };
const stats = { findingCount: 5, soldCount: 5, soldTarget: 5, stopReason: "target" };

const sevenAds = [1, 2, 3, 4, 5].map((i) => ({
  id: i, searchId: "s1", title: `Item ${i}`, snippet: "", url: `https://x.test/${i}`, site: "x.test", kind: "sold" as const,
  price: 60, currency: "USD", priceUsd: 60, gl: "se", origin: "SE", tier: "local" as const,
}));

describe("judge() (labels only, Haiku)", () => {
  it("returns a finished label answer as complete, with NO price or confidence of its own", async () => {
    const { deps } = makeDeps((_c, signal) => streamJudge(sampleVerdict(), signal));
    const r = await judge(deps, testConfig(), input, SAMPLE_IDENT, SAMPLE_DETAILS, sevenAds, stats, 2000);
    assert.equal(r.partial, false);
    assert.deepEqual(r.verdict.same, [1, 2, 3, 4, 5]);
    assert.equal(r.verdict.ads?.length, 5);
    assert.equal(r.verdict.confidence, 0); // set later by code (math.ts)
  });

  it("uses a cut-off answer when identity and labels are finished, and fills the rest only from the Eyes", async () => {
    const full = judgeJson(sampleVerdict());
    const cut = full.indexOf('"authenticity_risk"') - 1; // cut right after the ads
    const { deps } = makeDeps((_c, signal) => sseResponse(full, signal, { stopAfterChars: cut }));
    const r = await judge(deps, testConfig(), input, SAMPLE_IDENT, SAMPLE_DETAILS, sevenAds, stats, 500);
    assert.equal(r.partial, true);
    assert.deepEqual(r.verdict.same, [1, 2, 3, 4, 5]);
    assert.equal(r.verdict.display_name, SAMPLE_IDENT.display_name);
    assert.deepEqual(r.verdict.condition, SAMPLE_DETAILS.condition);
  });

  it("fails when not even one field was finished", async () => {
    const full = judgeJson(sampleVerdict());
    const { deps } = makeDeps((_c, signal) => sseResponse(full, signal, { stopAfterChars: 10 }));
    await assert.rejects(judge(deps, testConfig(), input, SAMPLE_IDENT, SAMPLE_DETAILS, sevenAds, stats, 400), StepError);
  });

  it("asks for streaming, with Haiku, adaptive thinking at high effort, and the item before the ads", async () => {
    const { deps, calls } = makeDeps((_c, signal) => streamJudge(sampleVerdict(), signal));
    await judge(deps, testConfig(), input, SAMPLE_IDENT, SAMPLE_DETAILS, sevenAds, stats, 2000);
    assert.equal(calls[0].body?.stream, true);
    assert.equal(calls[0].body?.model, "claude-haiku-5-5");
    assert.deepEqual(calls[0].body?.thinking, { type: "adaptive" });
    assert.deepEqual(calls[0].body?.output_config, { effort: "high" });
    assert.equal(calls[0].body?.max_tokens, JUDGE_THINKING_MAX_TOKENS, "room for the thinking AND the JSON");
    assert.ok(Number(calls[0].body?.max_tokens) >= 4000);
    const full = String(calls[0].body?.system);
    const system = full.slice(full.indexOf("Reply with ONE JSON object")); // the schema block only (the prose above mentions "ads" earlier)
    assert.ok(system.indexOf('"display_name"') < system.indexOf('"ads"'), "identity is written before any ad is labelled");
    assert.ok(system.indexOf('"identity_certainty"') < system.indexOf('"ads"'));
    assert.ok(system.indexOf('"ads"') < system.indexOf('"authenticity_risk"'));
    assert.ok(!full.includes("Think it through"), "the prompt no longer asks for extra thinking");
    assert.ok(full.includes("The reply is the JSON object and nothing else."));
  });

  it("the Judge never runs with thinking off; only medium and high exist; anything else means auto", async () => {
    const med = { ...testConfig(), judgeEffort: "medium" as const };
    const { deps, calls } = makeDeps((_c, signal) => streamJudge(sampleVerdict(), signal));
    await judge(deps, med, input, SAMPLE_IDENT, SAMPLE_DETAILS, sevenAds, stats, 2000);
    assert.deepEqual(calls[0].body?.thinking, { type: "adaptive" });
    assert.deepEqual(calls[0].body?.output_config, { effort: "medium" });
    assert.equal(judgeEffortOf("OFF"), "auto");
    assert.equal(judgeEffortOf("low"), "auto");
    assert.equal(judgeEffortOf("medium"), "medium");
    assert.equal(judgeEffortOf("banana"), "auto");
    assert.equal(judgeEffortOf(undefined), "auto");
  });
});

// ---------------------------------------------------------------- the 7 second guarantee

const PLAN = {
  ok: true, strategy_version: 2,
  searches: [
    { id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" },
    { id: "s2", query: "seiko snk809 såld", template_id: "fx_local_sold", kind: "exploit", gl: "se", hl: "sv" },
  ],
  stop: { sold_prices: 5, max_ms: 2000 },
};

function request(): Request {
  return new Request("https://x.test/f", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: FAKE_DATA_URL, currency: "SEK", country: "SE", deviceId: "device-0123456789abcdef" }) });
}

/** `planDelayMs`: how long the Search AI engine takes to answer (0 = at once). */
async function timed(route: Route, slowProtectionMs = 0, planDelayMs = 0) {
  const { deps } = makeDeps(route);
  const store = fakeStore();
  if (slowProtectionMs) {
    store.registerAttempt = async () => { await sleepMs(slowProtectionMs); return { verdict: "ok", attemptId: null }; };
  }
  const localPlan = fakeEngine(async () => {
    if (planDelayMs) await sleepMs(planDelayMs);
    return PLAN;
  });
  const ctx = { getConfig: () => testConfig(), store, deps, limits: DEFAULT_LIMITS, background: () => undefined, localPlan };
  const t0 = Date.now();
  const res = await handleRequest(request(), ctx);
  return { status: res.status, ms: Date.now() - t0, body: (await res.json()) as { result?: { degraded: string[]; status: string } } };
}

describe("the 7 second hard limit (whatever is slow)", () => {
  it("never exceeds 7 s, and the Judge gets every millisecond up to the limit", async () => {
    const full = judgeJson(sampleVerdict());
    const priceEnd = full.indexOf('"confidence"') - 1;

    const [slowJudge, slowEyes, slowDb, everythingSlow] = await Promise.all([
      // 1. Judge is slow: it writes the price, then goes quiet.
      timed(async (c: Call, s?: AbortSignal) => {
        if (c.url.includes("anthropic")) {
          const st = stepOf(c);
          if (st === "detail") return claudeReply(SAMPLE_DETAILS);
          if (st === "auth") return claudeReply(SAMPLE_AUTH);
          if (st === "ident") return claudeReply(SAMPLE_IDENT);
          return sseResponse(full, s, { stopAfterChars: priceEnd });
        }
        return serperSold(5, 60, "a");
      }),
      // 2. The Eyes are slow (2.6 s).
      timed(async (c: Call, s?: AbortSignal) => {
        if (c.url.includes("anthropic")) {
          const st = stepOf(c);
          if (st === "detail") { await sleepMs(2600, s); return claudeReply(SAMPLE_DETAILS); }
          if (st === "ident") { await sleepMs(2600, s); return claudeReply(SAMPLE_IDENT); }
          return streamJudge(sampleVerdict(), s, { delayMs: 150, pieces: 6 });
        }
        return serperSold(5, 60, "a");
      }),
      // 3. The database and the Search AI are slow, and the Judge is slow.
      timed(async (c: Call, s?: AbortSignal) => {
        if (c.url.includes("anthropic")) {
          const st = stepOf(c);
          if (st === "detail") return claudeReply(SAMPLE_DETAILS);
          if (st === "auth") return claudeReply(SAMPLE_AUTH);
          if (st === "ident") return claudeReply(SAMPLE_IDENT);
          return sseResponse(full, s, { stopAfterChars: priceEnd });
        }
        return serperSold(5, 60, "a");
      }, 550, 5000),
      // 4. Everything is slow at once.
      timed(async (c: Call, s?: AbortSignal) => {
        if (c.url.includes("anthropic")) {
          const st = stepOf(c);
          if (st === "detail") { await sleepMs(1900, s); return claudeReply(SAMPLE_DETAILS); }
          if (st === "ident") { await sleepMs(2000, s); return claudeReply(SAMPLE_IDENT); }
          return sseResponse(full, s, { delayMs: 900, pieces: 8 });
        }
        await sleepMs(6000, s);
        return serperSold(5, 60, "a");
      }, 550, 5000),
    ]);

    for (const [name, r] of Object.entries({ slowJudge, slowEyes, slowDb, everythingSlow })) {
      console.log(`# 7s-test ${name}: ${r.ms} ms, status ${r.status}, ${(r.body.result?.degraded ?? []).join(",")}`);
      assert.ok(r.ms < 7000, `${name}: took ${r.ms} ms`);
      assert.ok(r.status === 200 || r.status === 502, `${name}: status ${r.status}`);
    }
    // The Judge was given the time: a slow Judge is read right up to the end, not cut early.
    assert.ok(slowJudge.ms > 6000, `the Judge should have been allowed to use its time (${slowJudge.ms} ms)`);
    assert.equal(slowJudge.status, 200);
    assert.ok(slowJudge.body.result?.degraded.includes("judge_partial"));
  });
});
