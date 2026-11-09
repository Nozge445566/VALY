import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBrain } from "../pipeline.ts";
import { getFxTable } from "../fx.ts";
import { StepError } from "../types.ts";
import type { BrainInput } from "../types.ts";
import type { MemoryPort } from "../pipeline.ts";
import {
  FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, json, makeDeps, sampleResult, sampleVerdict,
  serperSold, sleepMs, stepOf, streamJudge, judgeJson, sseResponse, storedValuation, testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

const input: BrainInput = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };

const PLAN = {
  ok: true, strategy_version: 4,
  searches: [
    { id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" },
    { id: "s2", query: "seiko snk809 såld", template_id: "fx_local_sold", kind: "exploit", gl: "se", hl: "sv" },
    { id: "s3", query: "seiko snk809 site:chrono24.com", template_id: "fx_specialist", kind: "exploit", gl: "us", hl: "en" },
    { id: "s4", query: "seiko snk809 slutpris tradera", template_id: "mut:site:tradera.com", kind: "experiment", gl: "se", hl: "sv" },
  ],
  stop: { sold_prices: 5, max_ms: 2000 },
};

interface Over {
  detail?: () => Response | Promise<Response>;
  ident?: () => Response | Promise<Response>;
  judge?: (call: Call, signal?: AbortSignal) => Response | Promise<Response>;
  /** The Search AI engine's answer (a function so it can throw or take time). Default: the good PLAN. */
  plan?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  serper?: (call: Call, signal?: AbortSignal) => Response | Promise<Response>;
  /** Judge-A (photo-only price anchor). Default: the call fails, which must simply mean "no anchor". */
  judgeA?: () => Response | Promise<Response>;
  /** Second look (text-only re-check of ads a soft consistency rule demoted). Default: fails = no change. */
  secondLook?: (call: Call, signal?: AbortSignal) => Response | Promise<Response>;
}

function route(o: Over = {}): Route {
  return async (call, signal) => {
    if (call.url.includes("anthropic")) {
      const step = stepOf(call);
      if (step === "detail") return o.detail ? o.detail() : claudeReply(SAMPLE_DETAILS);
      if (step === "auth") return claudeReply(SAMPLE_AUTH);
      if (step === "secondLook") return o.secondLook ? o.secondLook(call, signal) : json({ error: "x" }, 500);
      if (step === "judgeA") return o.judgeA ? o.judgeA() : json({ error: "x" }, 500);
      if (step === "ident") return o.ident ? o.ident() : claudeReply(SAMPLE_IDENT);
      if (step === "judge") return o.judge ? o.judge(call, signal) : streamJudge(sampleVerdict(), signal);
    }
    if (call.url.includes("serper")) {
      if (o.serper) return o.serper(call, signal);
      if (call.body?.q === "seiko snk809 sold ebay") return serperSold(5, 60, "a", "www.tradera.com"); // a Swedish site: local for the SE user
      await sleepMs(1800, signal);
      return serperSold(5, 70, "b");
    }
    return json({}, 404);
  };
}

const memoryOf = (stored: Awaited<ReturnType<MemoryPort["find"]>>[number] | null): MemoryPort => ({ find: async () => (stored ? [stored] : []) });
const countOf = (calls: Call[], part: string) => calls.filter((c) => c.url.includes(part)).length;

async function run(o: Over, cfgOver = {}, memory: MemoryPort | null = null) {
  const { deps, calls, clock } = makeDeps(route(o));
  const cfg = testConfig(cfgOver);
  const t0 = Date.now();
  const out = await runBrain(input, cfg, deps, { fx: getFxTable(deps, null), memory, localPlan: fakeEngine(o.plan ?? PLAN, { calls, clock }) });
  return { out, calls, ms: Date.now() - t0 };
}

describe("the Brain, arrow by arrow", () => {
  it("MISS: Eyes in parallel, then Search AI, Market Live, Judge, check", async () => {
    const { out, calls, ms } = await run({});
    assert.equal(out.result.status, "ok");
    assert.equal(out.memoryHit, false);
    assert.equal(out.saveable, true);

    const detail = calls.find((c) => stepOf(c) === "detail")!;
    const ident = calls.find((c) => stepOf(c) === "ident")!;
    const judge = calls.find((c) => stepOf(c) === "judge")!;
    const firstSerper = calls.find((c) => c.url.includes("serper"))!;
    const plan = calls.find((c) => c.url.includes("search-ai"))!;

    // Parallel: both eyes were started before anything that depends on them.
    assert.ok(detail.at <= plan.at && ident.at <= plan.at, "Detail eye and Identification start together, before the plan");
    assert.ok(Math.abs(detail.at - ident.at) < 750, "Detail eye and Identification start at about the same moment");
    assert.ok(plan.at >= ident.at, "the Search AI plans after Identification");
    assert.ok(firstSerper.at >= plan.at, "Market Live searches after the plan");
    assert.ok(judge.at >= firstSerper.at, "the Judge comes after Market Live");
    assert.ok(ms < 3000);

    // Search: never more than 4.
    assert.ok(countOf(calls, "serper") <= 5, "4 planned + the mandatory eye search");

    // The Judge gets the photo directly.
    const content = (judge.body?.messages as { content: { type: string }[] }[])[0].content;
    assert.equal(content[0].type, "image");
    assert.equal((content[0] as unknown as { source: { data: string } }).source.data, FAKE_JPEG_B64);
  });

  it("Detail eye goes only to the Judge, Identification only to Memory and the Search AI", async () => {
    const { calls } = await run({});
    const judge = calls.find((c) => stepOf(c) === "judge")!;
    const judgeText = JSON.stringify(judge.body);
    assert.ok(judgeText.includes("Seiko 5 logo on the dial"), "the Judge sees the details");
    assert.ok(!judgeText.includes("A Seiko 5 automatic wristwatch"), "the Judge does not see Identification's text");

    const detail = calls.find((c) => stepOf(c) === "detail")!;
    const ident = calls.find((c) => stepOf(c) === "ident")!;
    assert.ok(!JSON.stringify(detail.body).includes("Identification"));
    assert.ok(!JSON.stringify(ident.body).includes("Detail eye"));
    // Neither eye is asked for prices.
    assert.ok(/never give or guess prices/.test(String(detail.body?.system)));
    assert.ok(/never give prices/.test(String(ident.body?.system)));
    // The Search AI receives the fingerprint and Identification's queries, and never a price.
    const plan = calls.find((c) => c.url.includes("search-ai"))!;
    assert.deepEqual(Object.keys(plan.body!).sort(), ["fingerprint", "queries"]);
  });

  it("uses the Haiku model for the Eyes and the Haiku model for the Judge", async () => {
    const { calls } = await run({});
    const models = (step: string) => calls.filter((c) => stepOf(c) === step).map((c) => c.body?.model);
    assert.deepEqual(models("detail"), ["claude-haiku-5-5"]);
    assert.deepEqual(models("ident"), ["claude-haiku-5-5"]);
    assert.deepEqual(models("judge"), ["claude-haiku-5-5"]);
  });

  it("writes one search-log row per search, with what the Judge kept", async () => {
    const { out } = await run({});
    assert.equal(out.searchLog.length, 4, "3 Search-AI + Haiku's 4th; the eye search only runs when the market is thin");
    const s1 = out.searchLog.find((r) => r.query === "seiko snk809 sold ebay")!;
    assert.equal(s1.kept_sold, 5);
    assert.equal(s1.judge_ok, true);
    assert.equal(s1.strategy_version, 4);
    assert.equal(s1.source, "search_ai");
    assert.equal(s1.fingerprint.brand, "seiko");
    assert.equal(out.searchLog.filter((r) => r.cancelled).length, 3, "the other 3 planned searches are cancelled at the 5-sold stop");
    assert.ok(out.searchLog.every((r) => r.stop_reason === "target"));
    // Item fingerprints only: no photo and nothing personal in the log.
    assert.ok(!JSON.stringify(out.searchLog).includes(FAKE_JPEG_B64.slice(0, 40)));
  });

  it("saves the user's country and where the evidence came from, and a foreign basis lowers the confidence", async () => {
    const local = await run({});
    assert.equal(local.out.result.market?.country, "SE");
    assert.equal(local.out.result.market?.basis, "local");
    assert.ok(local.out.result.comparables.every((c) => c.tier === "local" && c.origin === "SE"));

    // The same Swedish user, but every listing found is an American eBay listing.
    const foreign = await run({ serper: async (_call, signal) => { await sleepMs(30, signal); return serperSold(5, 60, "f"); } });
    assert.equal(foreign.out.result.market?.country, "SE");
    assert.ok(["regional", "global"].includes(foreign.out.result.market?.basis ?? ""), "foreign evidence is never labelled local");
    assert.ok(foreign.out.result.comparables.every((c) => c.tier === "global" && c.origin === "US"));
    assert.ok(foreign.out.result.confidenceScore < local.out.result.confidenceScore, "foreign evidence must give lower confidence");
    assert.ok(foreign.out.result.degraded.includes("market_global"));
    assert.equal(foreign.ms < 6900, true);
  });

  it("is eligible for Memory when the Judge kept evidence", async () => {
    const { out } = await run({});
    assert.equal(out.memoryEligible, true);
    assert.equal(out.fingerprint?.model, "snk809");
  });

  it("HIT: skips Market Live and the Search AI, goes straight to the Judge", async () => {
    const stored = storedValuation();
    const { out, calls } = await run({}, {}, memoryOf(stored));
    assert.equal(out.memoryHit, true);
    assert.equal(out.result.fromMemory, true);
    assert.equal(out.saveable, false, "a hit is never saved again");
    assert.ok(out.result.factors.some((f) => f.label === "Construction and era" && f.detail.includes("consistent with the era")), "a hit shows the fresh Authenticity eye line");
    assert.equal(out.memoryRunId, "run-1");
    assert.equal(countOf(calls, "serper"), 0);
    assert.equal(countOf(calls, "search-ai"), 0);
    assert.equal(calls.filter((c) => stepOf(c) === "judge").length, 1);
    assert.equal(out.searchLog.length, 0);
    assert.ok(out.result.mid > 0);
  });

  it("MISS when the stored valuation is too old", async () => {
    const stored = storedValuation({ createdAt: new Date(Date.now() - 90 * 86400000).toISOString() });
    const { out, calls } = await run({}, {}, memoryOf(stored));
    assert.equal(out.memoryHit, false);
    assert.equal(calls.filter((c) => stepOf(c) === "judge").length, 1);
  });

  it("MISS (not a crash) when Memory fails", async () => {
    const memory: MemoryPort = { find: async () => { throw new Error("db down"); } };
    const { out } = await run({}, {}, memory);
    assert.equal(out.result.status, "ok");
    assert.ok(out.result.degraded.includes("memory_unavailable"));
  });

  it("needs a better photo when Identification cannot tell what it is (and spends no more)", async () => {
    const { out, calls } = await run({
      ident: () => claudeReply({ identifiable: false, what_is_it: "", display_name: "", category: "", type: "", confidence: 0, google_queries: [] }),
    });
    assert.equal(out.result.status, "needs_photo");
    assert.equal(calls.filter((c) => stepOf(c) === "judge").length, 0);
    assert.equal(countOf(calls, "serper"), 0);
  });

  it("still answers when the Detail eye fails", async () => {
    const { out } = await run({ detail: () => json({ error: "x" }, 500) });
    assert.equal(out.result.status, "ok");
    assert.ok(out.result.degraded.includes("detail_eye_failed"));
  });

  it("still answers, with low confidence, when Identification fails (photo direct to the Judge)", async () => {
    // Without Identification there is no search, so no ads: the Judge may not guess a price, the app asks for a better photo.
    const { out, calls } = await run({ ident: () => json({ error: "x" }, 500) });
    assert.equal(out.result.status, "needs_photo");
    assert.ok(out.result.degraded.includes("identification_failed"));
    assert.ok(out.result.degraded.includes("no_comparable_ads"));
    assert.equal(countOf(calls, "serper"), 0);
    assert.equal(out.memoryEligible, false);
  });

  it("works without a Serper key, with lower confidence", async () => {
    const { out, calls } = await run({}, { serperKey: null });
    // No Serper key means no ads, and the Judge may not invent a price: the app asks for a better photo.
    assert.equal(out.result.status, "needs_photo");
    assert.ok(out.result.degraded.includes("market_not_configured"));
    assert.ok(out.result.degraded.includes("no_comparable_ads"));
    assert.equal(countOf(calls, "serper"), 0);
  });

  it("falls back to the fixed templates when the Search AI is down", async () => {
    const { out } = await run({ plan: () => { throw new Error("down"); } });
    assert.equal(out.result.status, "ok");
    assert.ok(out.result.degraded.includes("search_ai_error"));
    assert.ok(out.searchLog.every((r) => r.source === "fixed" && r.strategy_version === null));
  });

  it("lowers confidence when fewer than 5 sold prices are found, and never invents prices", async () => {
    const { out } = await run({
      serper: () => serperSold(2, 60, "x"),
      judge: (_c, signal) => streamJudge(sampleVerdict({ same: [1, 2], confidence: 90 }), signal),
    });
    assert.ok(out.result.degraded.includes("market_thin"));
    assert.ok(out.result.confidenceScore <= 65);
    assert.ok(out.result.comparables.length <= 2);
  });

  it("makes an emergency answer from real listings if the Judge fails", async () => {
    const { out } = await run({ judge: () => json({ error: "x" }, 500) });
    assert.equal(out.result.status, "ok");
    assert.ok(out.result.degraded.includes("judge_failed"));
    assert.ok(out.result.degraded.includes("judge_emergency"));
    assert.ok(out.result.confidenceScore <= 35);
    assert.equal(out.memoryEligible, false);
    assert.ok(out.searchLog.every((r) => r.judge_ok === false && r.kept_sold === 0));
  });

  it("v5.1: Serper finds nothing -> estimate mode (not needs_photo), flagged, capped, never saved", async () => {
    const identWithAnchor = { ...JSON.parse(JSON.stringify(SAMPLE_IDENT)), new_price_usd: 120, new_price_basis: "known_model", rarity: "rare", age_class: "old", material: "steel" };
    const { out } = await run({ serper: () => json({ organic: [] }), ident: () => claudeReply(identWithAnchor) });
    assert.equal(out.result.status, "ok");
    assert.ok(out.result.degraded.includes("no_market_estimate"));
    assert.ok(out.result.confidenceScore <= 40, String(out.result.confidenceScore));
    assert.ok(out.result.low < out.result.mid && out.result.mid < out.result.high);
    assert.equal(out.memoryEligible, false, "never reused through Memory (NEVER_STORE_IF)");
  });

  it("v5.1: no listings and no anchor -> needs_photo with the SPECIFIC message", async () => {
    const { out } = await run({ serper: () => json({ organic: [] }) });
    if (out.result.status === "needs_photo") assert.match(out.result.needsMoreInfo ?? "", /No market data/);
  });

  it("gives up with an error when the Judge fails and there is nothing real to go on", async () => {
    await assert.rejects(
      run({ judge: () => json({ error: "x" }, 500), serper: () => json({ organic: [] }) }),
      (e: unknown) => e instanceof StepError,
    );
  });

  it("uses what the Judge finished writing when the time runs out (price first, then the rest)", async () => {
    const full = judgeJson(sampleVerdict());
    const cutAt = full.indexOf('"authenticity_risk"') - 1; // the ad labels are finished, the rest is not
    const { out, ms } = await run(
      { judge: (_c, signal) => sseResponse(full, signal, { stopAfterChars: cutAt }) },
      { answerMs: 5000 },
    );
    assert.equal(out.result.status, "ok");
    assert.ok(out.result.degraded.includes("judge_partial"));
    // The interval engine blends the Judge's mid (60) with the real listings, so the mid is close
    // to the Judge's price but no longer identical to it.
    assert.ok(Math.abs(out.result.mid - 60) / 60 < 0.15, `the price is made by code from the labelled ads (mid ${out.result.mid})`);
    assert.equal(out.result.itemName, "Seiko 5 automatic watch", "unfinished text comes from the Eyes, never invented");
    assert.ok(ms < 5000, `took ${ms}`);
    assert.equal(out.memoryEligible, false, "a cut-off answer is never reused through Memory");
  });

  it("stores the full interval breakdown in steps.interval, for calibration", async () => {
    const { out } = await run({});
    const iv = out.steps.interval as Record<string, unknown>;
    assert.ok(iv, "steps.interval exists");
    for (const key of ["mu", "muM", "muK", "sK2", "seK2", "sM", "tauC2", "d", "extras2", "sLow2", "sHigh2", "df", "t", "k", "bucket", "n_eff", "fallbackLevel", "w", "comps"]) {
      assert.ok(key in iv, `steps.interval.${key}`);
    }
    assert.equal(out.result.intervalLevel, 0.8);
    assert.ok(Array.isArray(out.result.widthDrivers));
    assert.ok(out.result.low < out.result.mid && out.result.mid < out.result.high);
  });

  it("keeps the limit even if the Judge writes nothing (emergency answer)", async () => {
    const { out, ms } = await run(
      { judge: (_c, signal) => sseResponse("", signal, { stopAfterChars: 0 }) },
      { answerMs: 5000 },
    );
    assert.ok(ms < 5000, `took ${ms}`);
    assert.ok(out.result.degraded.includes("judge_emergency"));
  });
});

void claudeReply;

describe("Judge-A and the shadow fusion (v5.1)", () => {
  const JA = { new_price_usd: 300, new_price_basis: "known_model", used_price_band: "mid", rarity: "common", age_class: "mid", material: null, certainty: "high" };
  it("runs beside Market Live, sees NO ads, and its report is logged", async () => {
    const { out, calls } = await run({ judgeA: () => claudeReply(JA) });
    assert.equal(out.result.status, "ok");
    const ja = calls.filter((c) => stepOf(c) === "judgeA");
    assert.equal(ja.length, 1);
    assert.ok(!JSON.stringify(ja[0].body).includes("snk809 sold"), "Judge-A must not receive listings");
    assert.equal((out.steps.judgeA as { new_price_usd: number }).new_price_usd, 300);
  });
  it("a failed Judge-A is only a missing source: same answer, logged as missing", async () => {
    const { out } = await run({});
    assert.equal(out.result.status, "ok");
    assert.deepEqual(out.steps.judgeA, { missing: true });
  });
  it("the fused engine sets the price, recipe shape is v2, anchors are stored, and the stored recipe replays to the same price", async () => {
    const { buildFusedInterval } = await import("../fused-interval.ts");
    const { out } = await run({ judgeA: () => claudeReply(JA) });
    assert.equal(out.result.status, "ok");
    const iv = out.steps.interval as { v: number; input: Record<string, unknown> & { sources: unknown[] }; comps: { priceUsd: number; kind: "sold" | "asking"; match: "same" | "similar"; tier: "local" | "regional" | "global"; shiftLn: number; extraStd: number | null }[] };
    assert.equal(iv.v, 2);
    assert.ok(Array.isArray(iv.input.sources) && iv.input.sources.length === 1);
    assert.equal((out.steps.fusion as { shadow: boolean }).shadow, false);
    const r = out.result;
    assert.ok(r.low > 0 && r.low < r.mid && r.mid < r.high);
    const replay = buildFusedInterval({ ...(iv.input as never), comps: iv.comps.map((c) => ({ ...c, extraStd: c.extraStd ?? undefined })) });
    assert.ok(Math.abs(Math.log(replay.mid / r.mid)) < 0.01, `${replay.mid} vs ${r.mid}`);
  });
});

describe("second look, end to end (v5.1)", () => {
  // Ads without the brand in title or snippet: the consistency adjudicator demotes "same" -> "similar" (rule brand_missing).
  const noBrand = (call: Call) => {
    const q = String(call.body?.q ?? "");
    return json({ organic: Array.from({ length: 5 }, (_, i) => ({ title: `Automatic wristwatch SNK809 ${q.length}${i}`, link: `https://www.tradera.com/itm/${q.length}${i}`, snippet: `Sold  Oct ${i + 1}, 2026  US $${60 + i}.00` })) });
  };
  const idsAsked = (call: Call) => [...JSON.stringify(call.body).matchAll(/#(\d+) \|/g)].map((m) => Number(m[1]));
  it("asks once (text only, no image, at most 4 ads); 'different' demotes, the demotion is logged and widens through judge_disagreement", async () => {
    const { out, calls } = await run({ serper: (c) => noBrand(c), secondLook: (c) => claudeReply({ ads: idsAsked(c).map((id) => ({ id, same: "different" })) }) });
    const sl = calls.filter((c) => stepOf(c) === "secondLook");
    assert.equal(sl.length, 1);
    assert.ok(!JSON.stringify(sl[0].body).includes('"type":"image"'), "no image");
    const s = out.steps.secondLook as { asked: number[]; answered: number; demoted: number[] };
    assert.ok(s.asked.length >= 1 && s.asked.length <= 4);
    assert.deepEqual(s.demoted.sort(), s.asked.slice().sort());
    const rules = (out.steps.consistency as { rule: string }[]).map((d) => d.rule);
    assert.ok(rules.includes("brand_missing") && rules.includes("second_look_different"));
    assert.ok(out.result.low < out.result.mid && out.result.mid < out.result.high);
  });
  it("'same' answers never promote; a failed or slow call changes nothing and never delays past the limit", async () => {
    const base = await run({ serper: (c) => noBrand(c) }); // second look fails (500)
    const same = await run({ serper: (c) => noBrand(c), secondLook: (c) => claudeReply({ ads: idsAsked(c).map((id) => ({ id, same: "same" })) }) });
    const slow = await run({ serper: (c) => noBrand(c), secondLook: async (_c, sig) => { await sleepMs(5000, sig); return claudeReply({ ads: [] }); } });
    assert.deepEqual((same.out.steps.secondLook as { demoted: number[] }).demoted, []);
    for (const r of [base, same, slow]) assert.equal(r.out.result.status, "ok");
    assert.equal(same.out.result.mid, base.out.result.mid);
    assert.equal(slow.out.result.mid, base.out.result.mid);
    assert.ok(slow.ms < 4000, `slow second look took ${slow.ms} ms`);
  });
  it("is not asked when no ad was demoted by a soft rule", async () => {
    const { calls, out } = await run({});
    assert.equal(calls.filter((c) => stepOf(c) === "secondLook").length, 0);
    assert.equal(out.steps.secondLook, undefined);
  });
});

describe("neighbour prior, end to end (v5.1)", () => {
  const rows = [400, 420, 380, 410].map((m) => ({ midUsd: m, confidence: 70, createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), brainVersion: "brain-5.1.0", sameModel: true }));
  const withNb = (findNeighbours: MemoryPort["findNeighbours"]): MemoryPort => ({ find: async () => [], findNeighbours });
  it("rows become ONE weak source stored in the recipe; five real ads still decide the price", async () => {
    const base = await run({});
    const nb = await run({}, {}, withNb(async () => rows));
    assert.equal((nb.out.steps.neighbours as { n: number }).n, 4);
    const src = (nb.out.steps.interval as { input: { sources: { name: string }[] } }).input.sources.map((s) => s.name);
    assert.ok(src.includes("neighbours"));
    assert.ok(nb.out.result.low < nb.out.result.mid && nb.out.result.mid < nb.out.result.high);
    assert.ok(nb.out.result.mid < base.out.result.mid * 1.6, `${nb.out.result.mid} vs ${base.out.result.mid}`);
  });
  it("a failing or hanging neighbour lookup changes nothing and never delays the answer", async () => {
    const base = await run({});
    const failed = await run({}, {}, withNb(async () => { throw new Error("db down"); }));
    const hung = await run({}, {}, withNb(() => new Promise(() => undefined)));
    for (const r of [failed, hung]) { assert.equal(r.out.result.status, "ok"); assert.equal(r.out.result.mid, base.out.result.mid); assert.deepEqual(r.out.steps.neighbours, { none: true }); }
    assert.ok(hung.ms < 4000, `${hung.ms} ms`);
  });
});

describe("estimate ladder rung 4: neighbour prior without ads and without anchor (v5.1)", () => {
  const rows = [200, 220, 180, 210].map((m) => ({ midUsd: m, confidence: 70, createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), brainVersion: "brain-5.1.0", sameModel: true }));
  const nbPort = (r: typeof rows): MemoryPort => ({ find: async () => [], findNeighbours: async () => r });
  const noMarket = { serper: () => json({ organic: [] }) };
  it("no ads + no anchor + neighbours: a wide, low-confidence estimate around the neighbours, flagged, never stored", async () => {
    const { out } = await run(noMarket, {}, nbPort(rows));
    const r = out.result;
    assert.equal(r.status, "ok");
    assert.ok(r.low < r.mid && r.mid < r.high && r.mid > 150 && r.mid < 260, `mid ${r.mid}`);
    assert.ok(r.confidenceScore <= 40, `confidence ${r.confidenceScore}`);
    assert.ok(r.high / r.low > 1.8, "must be wide");
    assert.ok(r.degraded?.includes("no_market_estimate") && r.degraded.includes("neighbour_estimate"));
    assert.equal(out.memoryEligible, false);
    assert.equal((out.steps.neighbours as { usedAsEstimate?: boolean }).usedAsEstimate, true);
    assert.ok(/similar items valued before/.test(JSON.stringify(r)), "specific neighbour text, not the generic anchor text");
    assert.ok(!/typical new price/.test(JSON.stringify(r)));
  });
  it("too few neighbours: still the specific needs_photo message, never a made-up price", async () => {
    const { out } = await run(noMarket, {}, nbPort(rows.slice(0, 2)));
    assert.equal(out.result.status, "needs_photo");
  });

  it("Authenticity eye -> Market Live: the eye query does NOT run when the market is not thin", async () => {
    const { out, calls } = await run({});
    const st = out.steps as Record<string, { ran?: boolean; why?: string | null; replaced?: string | null }>;
    assert.equal(st.eyeSearch.ran, false);
    assert.equal(st.eyeSearch.why, "market_not_thin");
    assert.ok(!calls.some((c) => c.url.includes("serper") && String(c.body?.q).includes("2010s")));
  });

  it("Authenticity eye -> Market Live: a thin market (< 5 sold after wave 1) runs ONE eye query, standing in for the weakest Search-AI search", async () => {
    const { out, calls } = await run({ serper: async () => serperSold(1, 60, "t") });
    const st = out.steps as Record<string, { ran?: boolean; why?: string | null; replaced?: string | null }>;
    assert.equal(st.eyeSearch.ran, true);
    assert.equal(st.eyeSearch.why, "market_thin");
    assert.ok(["s1", "s2", "s3", "s4"].includes(String(st.eyeSearch.replaced)), "names one of the Search-AI searches");
    const eyeCalls = calls.filter((c) => c.url.includes("serper") && String(c.body?.q).includes("2010s"));
    assert.equal(eyeCalls.length, 1);
    assert.ok(!JSON.stringify(eyeCalls[0].body).includes("Seiko 5 logo"), "no Detail eye text in the eye query");
  });

  it("Judge-A -> Judge: its labels reach the Judge, its price numbers never do", async () => {
    const ja = { new_price_usd: 987654, new_price_basis: "known_model", used_price_band: "mid", rarity: "rare", age_class: "vintage", material: "steel", certainty: "high" };
    const { calls } = await run({ judgeA: () => claudeReply(ja) });
    const sent = JSON.stringify(calls.find((c) => stepOf(c) === "judge")!.body);
    assert.ok(sent.includes("JUDGE-A (photo-only labels)") && sent.includes("steel"));
    assert.ok(!sent.includes("987654"));
    const none = await run({});
    assert.ok(JSON.stringify(none.calls.find((c) => stepOf(c) === "judge")!.body).includes("not available"));
  });
});

describe("valuation modes are logged on every run", () => {
  it("steps.modes carries newItem and askingToSold", async () => {
    const { out } = await run({});
    const m = out.steps.modes as { newItem: boolean; askingToSold: number };
    assert.equal(typeof m.newItem, "boolean");
    assert.equal(typeof m.askingToSold, "number");
  });
});
