// Two fixes (4 Nov 2026), both about HONEST CREDIT for each search:
//   1. A search is credited for every sold listing it found itself, also when another parallel search delivered the same
//      listing a few milliseconds earlier (the duplicate filter keeps ONE copy for the Judge; it must not decide the credit).
//   2. The learned Haiku weight is scored on price accuracy against what the OTHER searches found (not on counts, and never
//      against the search's own median), and a listing found by several searches counts once in the pooled median.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HAIKU_WEIGHT_MIN, HAIKU_LINK_WEIGHT, learnHaikuWeights, rewardWithHaikuWeight, slimLearnSearches } from "../connector-learn.ts";
import type { LearnSearch, LogRowForLearning } from "../connector-learn.ts";
import { FALLBACK_RATES, getFxTable } from "../../value-item/fx.ts";
import { hitsToFindings, OWN_SOLD_MAX, runMarketLive, serperHits } from "../../value-item/market-live.ts";
import { runBrain } from "../../value-item/pipeline.ts";
import type { PlannedSearch, SearchPlan } from "../../value-item/types.ts";
import { FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, json, makeDeps, sampleVerdict, sleepMs, stepOf, streamJudge, testConfig } from "../../value-item/tests/helpers.ts";
import type { Call, Route } from "../../value-item/tests/helpers.ts";

const search = (id: string, query: string, gl = "us"): PlannedSearch => ({ id, query, template_id: `t_${id}`, kind: "exploit", gl, hl: "en" });
const twoSearchPlan = (): SearchPlan => ({ strategyVersion: 1, source: "fixed", searches: [search("s1", "q one"), search("s2", "q two")], stop: { soldPrices: 5, maxMs: 2000 } });
const searchAiDown = fakeEngine(() => { throw new Error("search ai is down"); });

const LISTINGS = [
  { title: "Seiko 5 SNK809 a0", link: "https://www.ebay.com/itm/a0", snippet: "Sold  Oct 1, 2026  US $60.00" },
  { title: "Seiko 5 SNK809 a1", link: "https://www.ebay.com/itm/a1", snippet: "Sold  Oct 2, 2026  US $61.00" },
];

// ---------------------------------------------------------------- hitsToFindings

describe("hitsToFindings: own credit is separate from what the Judge sees", () => {
  const raw = (rows: typeof LISTINGS) => serperHits({ organic: rows });

  it("a listing another search already delivered is NOT a finding again, but IS in this search's own sold prices", () => {
    const seen = new Set<string>();
    const first = hitsToFindings(raw(LISTINGS), search("s1", "q one"), FALLBACK_RATES, seen);
    const second = hitsToFindings(raw(LISTINGS), search("s2", "q two"), FALLBACK_RATES, seen);
    assert.equal(first.findings.length, 2);
    assert.equal(second.findings.length, 0, "the Judge never sees one listing twice");
    assert.equal(second.dropped, 2, "the old count of dropped hits is unchanged");
    assert.deepEqual(second.ownSold.map((x) => x.usd), [60, 61], "but the second search found both and keeps the credit");
    assert.deepEqual(first.ownSold.map((x) => x.usd), [60, 61]);
  });

  it("only SOLD listings count, each listing once inside a search, in Google's order", () => {
    const rows = [
      { title: "Watch b0", link: "https://www.ebay.com/itm/b0", snippet: "Sold  Oct 1, 2026  US $70.00" },
      { title: "Watch b0 again", link: "https://ebay.com/itm/b0/", snippet: "Sold  Oct 1, 2026  US $70.00" },
      { title: "Watch asking", link: "https://www.example.com/p/1", snippet: "Buy it now US $99.00" },
      { title: "Watch b1", link: "https://www.ebay.com/itm/b1", snippet: "Sold  Oct 3, 2026  US $65.00" },
    ];
    const out = hitsToFindings(raw(rows), search("s1", "q"), FALLBACK_RATES, new Set());
    assert.deepEqual(out.ownSold.map((x) => x.usd), [70, 65]);
    assert.equal(out.findings.some((f) => f.kind !== "sold"), true, "asking findings still exist, they just are not sold credit");
  });
});

// ---------------------------------------------------------------- inside Market Live

describe("Market Live: who is a few milliseconds faster does not change the credit", () => {
  const timed = (fastQuery: string): Route => async (call, signal) => {
    const q = String(call.body?.q);
    await sleepMs(q === fastQuery ? 5 : 60, signal);
    return json({ organic: LISTINGS });
  };
  const run = (fastQuery: string, extra: Record<string, unknown> = {}) =>
    runMarketLive(makeDeps(timed(fastQuery)).deps, testConfig(), twoSearchPlan(), { budgetMs: 2000, rates: FALLBACK_RATES, ...extra });

  it("either search first: both get the SAME own sold prices and the SAME listing keys", async () => {
    const aFirst = await run("q one", { collectHitKeys: true });
    const bFirst = await run("q two", { collectHitKeys: true });
    for (const r of [aFirst, bFirst]) {
      const [a, b] = r.outcomes;
      assert.deepEqual(a.ownSold!.map((x) => x.usd), [60, 61]);
      assert.deepEqual(b.ownSold!.map((x) => x.usd), [60, 61]);
      assert.deepEqual(a.ownSold!.map((x) => x.key), b.ownSold!.map((x) => x.key), "the same listing has the same key in both searches");
    }
    // The Judge still gets exactly one copy of each listing, from whichever search was first.
    assert.equal(aFirst.findings.length, 2);
    assert.equal(bFirst.findings.length, 2);
    assert.equal(aFirst.findings[0].searchId, "s1");
    assert.equal(bFirst.findings[0].searchId, "s2");
  });

  it("option off: ownSold is still there (prices only, NO listing keys), and findings are exactly what they were", async () => {
    const plain = await run("q one");
    const explicitOff = await run("q one", { collectHitKeys: false });
    const on = await run("q one", { collectHitKeys: true });
    for (const o of [...plain.outcomes, ...explicitOff.outcomes]) {
      assert.deepEqual(o.ownSold!.map((x) => x.usd), [60, 61], "the Search AI is credited whatever the Connector mode is");
      for (const x of o.ownSold!) assert.equal("key" in x, false, "keys exist only when overlap data was asked for");
      assert.equal("hitKeys" in o, false);
    }
    for (const o of on.outcomes) for (const x of o.ownSold!) assert.equal(typeof x.key, "string");
    assert.deepEqual(on.findings, plain.findings, "collecting own prices must not change a single finding");
    assert.deepEqual(explicitOff.findings, plain.findings);
    assert.equal(on.droppedCount, plain.droppedCount);
    assert.equal(explicitOff.droppedCount, plain.droppedCount);
  });

  it("keeps at most OWN_SOLD_MAX prices per search", async () => {
    const many = async () => json({ organic: Array.from({ length: 10 }, (_, i) => ({ title: `Watch ${i}`, link: `https://www.ebay.com/itm/m${i}`, snippet: `Sold  US $${50 + i}.00` })) });
    const r = await runMarketLive(makeDeps(many).deps, testConfig(), twoSearchPlan(), { budgetMs: 2000, rates: FALLBACK_RATES, collectHitKeys: true });
    for (const o of r.outcomes) assert.ok(o.ownSold!.length <= OWN_SOLD_MAX);
  });
});

// ---------------------------------------------------------------- inside the Brain

describe("The Connector's log: every search is credited for what it found", () => {
  const IDENT = { ...SAMPLE_IDENT, brand: "Orrefors", model: null, type: "vase", category: "antiques", google_queries: ["orrefors vas såld slutpris"] };
  const input = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };
  let calls = 0;
  const route: Route = async (call: Call, signal?: AbortSignal) => {
    if (call.url.includes("anthropic")) {
      const s = stepOf(call);
      if (s === "detail") return claudeReply(SAMPLE_DETAILS);
      if (s === "auth") return claudeReply(SAMPLE_AUTH);
      if (s === "ident") return claudeReply(IDENT);
      return streamJudge(sampleVerdict(), signal);
    }
    if (call.url.includes("serper")) {
      calls += 1;
      await sleepMs(calls === 1 ? 2 : 40, signal); // the first search to run answers well before the others
      // Two sold listings only: below the stopper's target of 5, so no search is cancelled.
      return json({ organic: [
        { title: "Orrefors vas c0", link: "https://www.ebay.com/itm/c0", snippet: "Sold  Oct 1, 2026  US $60.00" },
        { title: "Orrefors vas c1", link: "https://www.ebay.com/itm/c1", snippet: "Sold  Oct 2, 2026  US $61.00" },
      ] });
    }
    return json({}, 404);
  };

  it("the slower searches get the same prices and keys as the fastest one; keys stay out of l_runs and l_search_log", async () => {
    calls = 0;
    const { deps } = makeDeps(route);
    const out = await runBrain(input, testConfig({ connectorShare: 1 }), deps, { fx: getFxTable(deps, null), localPlan: searchAiDown, memory: null, connectorDraw: () => 0 });
    const rows = (out.connectorLog!.searches as Array<Record<string, unknown>>).filter((r) => r.cancelled === false && r.failed === false);
    assert.ok(rows.length >= 2, "at least two searches answered");
    const keyed = rows.map((r) => ({ prices: r.prices as number[], keys: r.price_keys as string[] }));
    for (const k of keyed) {
      assert.equal(k.prices.length, 2, "every answered search is credited with both listings, not only the one that was first");
      assert.equal(k.keys.length, k.prices.length);
    }
    assert.deepEqual(keyed.map((k) => [...k.keys].sort()).filter((_, i, all) => JSON.stringify(all[i]) !== JSON.stringify(all[0])), [], "all searches saw the same two listings");
    for (const r of rows) assert.ok(!JSON.stringify(r).includes("tradera.com/item"), "no raw link in the log row");
    const hay = JSON.stringify({ steps: out.steps, searchLog: out.searchLog });
    assert.ok(!hay.includes("price_keys") && !hay.includes("ownSold"), "keys never reach l_runs or l_search_log");
  });
});

// ---------------------------------------------------------------- the learner

const ps = (usd: number[], keys: string[] | undefined, over: Partial<LearnSearch> = {}): LearnSearch => ({
  rule: null, original_query: "a", executed_query: "a", is_haiku: false, kept_sold: 0, discarded: 0, prices: usd, ...(keys ? { price_keys: keys } : {}), latency_ms: 1000, cancelled: false, failed: false, ...over,
});

describe("one listing counts once in the pooled median", () => {
  it("two searches that found the same two listings do not outvote a third search's three different ones", () => {
    const a = ps([100, 100], ["a1", "a2"]);
    const b = ps([100, 100], ["a1", "a2"]); // the same two listings as a
    const c = ps([300, 300, 300], ["c1", "c2", "c3"]);
    const withKeys = rewardWithHaikuWeight([a, b, c], [c], 1) as number;
    const noKeys = rewardWithHaikuWeight([a, b, c].map((x) => ({ ...x, price_keys: undefined })), [c], 1) as number;
    // With keys the pool is 100,100,300,300,300 (median 300): c is exactly right. Without keys the pool is 100x4,300x3 (median 100): c is far off.
    assert.ok(withKeys > noKeys, `${withKeys} vs ${noKeys}`);
  });

  it("older rows without keys, or with keys that do not match the prices, behave exactly as before", () => {
    const a = ps([100, 110], undefined);
    const b = ps([100, 110], ["only-one-key"]); // length mismatch: ignored
    const c = ps([100, 110], undefined);
    assert.equal(rewardWithHaikuWeight([a, b, c], [a, b, c], 1), rewardWithHaikuWeight([a, b, c].map((x) => ({ ...x, price_keys: undefined })), [a, b, c], 1));
  });
});

describe("the Haiku weight does not depend on which search was faster", () => {
  /** Haiku and one template find the SAME listings; the second template finds other (right) ones. `haikuFirst` only decides who got the finding. */
  const row = (i: number, haikuFirst: boolean): LogRowForLearning => {
    const shared = ["k1", "k2", "k3"];
    // Old behaviour: the search that was second had NO prices. New behaviour: both carry them. The two orders must give one answer.
    return {
      mode: "shadow", applied: false, proposed_changes: 0, bucket: "SE|antiques|fixed", judge_ok: false, reward: null,
      searches: [
        ps([100, 100, 100], shared, { is_haiku: true }),
        ps([100, 100, 100], shared),
        ps([100, 100, 100], ["k4", "k5", "k6"]),
      ].map((s, idx) => (idx === 0 && !haikuFirst ? { ...s, latency_ms: 1900 } : s)),
    };
  };
  it("the same listings found by Haiku and a template give Haiku the same score in both orders", () => {
    const a = learnHaikuWeights(Array.from({ length: 60 }, (_, i) => row(i, true)));
    const b = learnHaikuWeights(Array.from({ length: 60 }, (_, i) => row(i, false)));
    assert.equal(a[0].ratio > 0, true);
    // only the latency differs (speed is at most 15 % of a score); the credit for the listings is identical
    assert.ok(Math.abs(a[0].ratio - b[0].ratio) < 0.2);
    assert.ok(a[0].haiku_weight >= HAIKU_WEIGHT_MIN && b[0].haiku_weight >= HAIKU_WEIGHT_MIN && a[0].haiku_weight <= HAIKU_LINK_WEIGHT + 0.05);
  });
});

describe("slimLearnSearches (the nightly function's reader)", () => {
  it("keeps prices and price_keys together, in the same order", () => {
    const out = slimLearnSearches([{ is_haiku: true, executed_query: "q", original_query: "q", prices: [100, "x", 0, 120], price_keys: ["a", "b", "c", "d"], cancelled: false }])!;
    assert.deepEqual(out[0].prices, [100, 120]);
    assert.deepEqual(out[0].price_keys, ["a", "d"], "an invalid price takes its key with it");
  });
  it("leaves the keys out when they do not match the prices, and for older rows without keys", () => {
    const a = slimLearnSearches([{ prices: [100, 120], price_keys: ["only-one"] }])!;
    assert.equal("price_keys" in a[0], false);
    const b = slimLearnSearches([{ prices: [100, 120] }])!;
    assert.deepEqual(b[0].prices, [100, 120]);
    assert.equal("price_keys" in b[0], false);
    const c = slimLearnSearches([{ kept_sold: 3 }])!;
    assert.equal(c[0].prices, undefined, "a legacy row stays legacy");
  });
  it("skips bad entries and tolerates a non-array", () => {
    assert.equal(slimLearnSearches(null), undefined);
    assert.deepEqual(slimLearnSearches([null, 7, {}])!.length, 1);
  });
});
