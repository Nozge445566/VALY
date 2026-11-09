// Country adaptation, part 1: tiers, the ladder in Market Live, the confidence maths,
// Identification's local queries, and the Memory country lock. No network, no cost.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FALLBACK_RATES } from "../fx.ts";
import { buildFusedInterval as buildInterval } from "../fused-interval.ts";
import type { RawComp } from "../interval.ts";
import { runMarketLive, selectFindings } from "../market-live.ts";
import {
  effectiveSold, escalationSearches, findingCountry, isThinData, marketBasis, nextTiers, regionalPeers, tierOf, tierWeight,
} from "../market-tiers.ts";
import { localQueryGuide } from "../eyes.ts";
import { isUsableHit } from "../memory.ts";
import { extractMoney } from "../money.ts";
import type { Fingerprint, PlannedSearch, SearchPlan } from "../types.ts";
import { json, makeDeps, sampleResult, sleepMs, storedValuation, testConfig } from "./helpers.ts";

const fp = (country: string, language = "sv"): Fingerprint => ({
  category: "watch", brand: "seiko", type: "automatic watch", model: "snk809", era: null, country, language,
});

describe("tiers", () => {
  it("regional peers are real neighbours with a known marketplace, never the country itself", () => {
    assert.deepEqual(regionalPeers("SE"), ["NO", "DK", "FI"]); // IS has no marketplace entry
    assert.ok(regionalPeers("DE").includes("AT"));
    assert.ok(!regionalPeers("DE").includes("DE"));
    assert.deepEqual(regionalPeers("ZZ"), []);
    assert.deepEqual(regionalPeers(null), []);
  });

  it("the page decides the country of a listing, the search only decides when the page is global", () => {
    assert.equal(findingCountry("www.tradera.com", "us"), "SE");
    assert.equal(findingCountry("ebay.com", "se"), "US"); // ebay.com is American whatever gl was
    assert.equal(findingCountry("www.ebay.de", "us"), "DE");
    assert.equal(findingCountry("ebay.co.uk", "us"), "GB");
    assert.equal(findingCountry("something.com.au", "us"), "AU");
    assert.equal(findingCountry("chrono24.com", "de"), "DE"); // no country of its own: the search's gl
  });

  it("tierOf: own country local, neighbours regional, the rest global, unknown user never foreign", () => {
    assert.equal(tierOf("SE", "SE"), "local");
    assert.equal(tierOf("NO", "SE"), "regional");
    assert.equal(tierOf("US", "SE"), "global");
    assert.equal(tierOf("US", null), "local");
    assert.equal(tierOf("US", "ZZ"), "local");
  });

  it("tier weights follow the same noise the interval engine adds, and fall in order", () => {
    assert.equal(tierWeight("local"), 1);
    assert.ok(tierWeight("regional") < 1 && tierWeight("regional") > tierWeight("global"));
    assert.ok(Math.abs(tierWeight("regional") - 0.8) < 0.01);
    assert.ok(Math.abs(tierWeight("global") - 0.552) < 0.01);
    // Five global sold prices are worth about 2.8 local ones: not "enough" for a target of 5.
    const five = Array.from({ length: 5 }, () => ({ kind: "sold", tier: "global" as const }));
    assert.ok(effectiveSold(five) > 2.6 && effectiveSold(five) < 3);
  });

  it("thin countries get a parallel global search; rich ones and unknown ones do not; learned data wins", () => {
    assert.equal(isThinData("DE"), false);
    assert.equal(isThinData("SE"), true, "Sweden is not on the starting list: a parallel global search from the first request");
    assert.equal(isThinData("FI"), true);
    assert.equal(isThinData(null), false);
    assert.equal(isThinData("ZZ"), false);
    assert.equal(isThinData("FI", new Map([["FI", 3]])), false);
    assert.equal(isThinData("DE", new Map([["DE", 0.2]])), true);
  });

  it("nextTiers jumps straight to both tiers when nothing was found, otherwise one step at a time", () => {
    assert.deepEqual(nextTiers(["local"], 0), ["regional", "global"]);
    assert.deepEqual(nextTiers(["local"], 2), ["regional"]);
    assert.deepEqual(nextTiers(["local", "regional"], 2), ["global"]);
    assert.deepEqual(nextTiers(["local", "regional", "global"], 0), []);
  });

  it("escalation searches use the neighbour's language and never repeat a query", () => {
    const [reg] = escalationSearches(fp("SE"), ["regional"], new Set(), 5);
    assert.equal(reg.gl, "no");
    assert.match(reg.query, /solgt/);
    assert.equal(reg.tier, "regional");
    const [glob] = escalationSearches(fp("SE"), ["global"], new Set(), 5);
    assert.equal(glob.gl, "us");
    assert.equal(glob.tier, "global");
    const again = escalationSearches(fp("SE"), ["global"], new Set([glob.query.toLowerCase()]), 5);
    assert.notEqual(again[0]?.query, glob.query);
  });

  it("marketBasis says local only when almost everything is local, and counts the tiers", () => {
    assert.equal(marketBasis("SE", [{ tier: "local" }, { tier: "local" }, { tier: "local" }, { tier: "local" }, { tier: "local" }, { tier: "regional" }]).basis, "local");
    assert.equal(marketBasis("SE", [{ tier: "local" }, { tier: "global" }]).basis, "global");
    assert.equal(marketBasis("SE", [{ tier: "regional" }, { tier: "regional" }, { tier: "global" }]).basis, "regional");
    assert.equal(marketBasis("SE", []).basis, "none");
    assert.equal(marketBasis(null, [{ tier: "local" }]).country, "ZZ");
    assert.deepEqual(marketBasis("SE", [{ tier: "regional" }, { tier: "global" }, { tier: "global" }]), { country: "SE", basis: "global", local: 0, regional: 1, global: 2 });
  });
});

describe("confidence maths", () => {
  const model = { low: 150, mid: 200, high: 260 };
  const comps = (tier: "local" | "regional" | "global"): RawComp[] =>
    [190, 200, 205, 210, 195, 215].map((p) => ({ priceUsd: p, kind: "sold" as const, match: "same" as const, tier }));
  const run = (c: RawComp[]) => buildInterval({ model, modelConfidence: 70, comps: c, category: "watch", condition: "good", authenticityRisk: "low", unknownsCount: 1 });

  it("the same prices give a wider range and a lower score the more foreign they are", () => {
    const l = run(comps("local")), r = run(comps("regional")), g = run(comps("global"));
    assert.ok(l.confidenceScore >= r.confidenceScore && r.confidenceScore >= g.confidenceScore);
    assert.ok(l.confidenceScore > g.confidenceScore, "global must be strictly less certain than local");
    const width = (o: typeof l) => Math.log(o.high / o.low);
    assert.ok(width(l) < width(r) && width(r) < width(g));
    assert.equal(l.breakdown.foreignShare, 0);
    assert.ok(g.breakdown.foreignShare > 0.999 && g.breakdown.foreignStd > 0.17);
  });

  it("a mix lands between the pure cases (smooth, no steps)", () => {
    const mixed = [...comps("local").slice(0, 3), ...comps("global").slice(0, 3)];
    const m = run(mixed), l = run(comps("local")), g = run(comps("global"));
    assert.ok(m.breakdown.foreignShare > 0.2 && m.breakdown.foreignShare < 0.5, "global weighs less, so its share is below 50%");
    assert.ok(m.confidenceScore <= l.confidenceScore && m.confidenceScore >= g.confidenceScore);
  });

  it("comparables without a tier behave exactly as before (old saved runs replay the same)", () => {
    const old = comps("local").map(({ priceUsd, kind, match }) => ({ priceUsd, kind, match }));
    const a = run(old), b = run(comps("local"));
    assert.equal(a.low, b.low);
    assert.equal(a.high, b.high);
    const asGlobal = buildInterval({ model, modelConfidence: 70, comps: old, category: "watch", condition: "good", authenticityRisk: "low", unknownsCount: 1, fallbackLevel: "global" });
    assert.ok(asGlobal.confidenceScore <= a.confidenceScore);
  });
});

describe("Market Live: the ladder", () => {
  const search = (id: string, query: string, gl: string, hl = "sv"): PlannedSearch => ({ id, query, template_id: `t_${id}`, kind: "exploit", gl, hl });
  const plan = (): SearchPlan => ({
    strategyVersion: 1, source: "search_ai",
    searches: [search("s1", "seiko snk809 såld", "se"), search("s2", "seiko snk809 site:tradera.com", "se")],
    stop: { soldPrices: 5, maxMs: 2000 },
  });
  const sold = (host: string, n: number, base: number, tag: string) =>
    json({ organic: Array.from({ length: n }, (_, i) => ({ title: `Seiko 5 SNK809 ${tag}${i}`, link: `https://${host}/i/${tag}${i}`, snippet: `Sold ${base + i} USD` })) });
  const empty = () => json({ organic: [] });

  it("goes to the region and then the world when the user's own country gives nothing", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps(async (call) => {
      seen.push(`${call.body?.gl}`);
      if (call.body?.gl === "se") return empty();
      if (call.body?.gl === "no") return sold("finn.no", 2, 100, "n");
      return sold("www.ebay.com", 3, 110, "u");
    });
    const report = await runMarketLive(deps, testConfig(), plan(), { budgetMs: 2000, rates: FALLBACK_RATES, fingerprint: fp("SE") });
    assert.ok(seen.includes("no") && seen.includes("us"), `expected NO and US searches, got ${seen}`);
    assert.deepEqual(report.tiersUsed.slice(0, 1), ["local"]);
    assert.ok(report.tiersUsed.includes("regional") && report.tiersUsed.includes("global"));
    assert.deepEqual(new Set(report.findings.map((f) => f.tier)), new Set(["regional", "global"]));
    assert.ok(report.effectiveSold < 5 && report.effectiveSold > 3);
    assert.ok(report.outcomes.length <= 7);
  });

  it("stays local and does not escalate when the local searches found enough", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps(async (call) => {
      seen.push(`${call.body?.gl}`);
      return sold("www.tradera.com", 5, 100, "t");
    });
    // Sweden is measured as rich here (the starting list no longer says so by itself): no parallel global search.
    const report = await runMarketLive(deps, testConfig(), plan(), {
      budgetMs: 2000, rates: FALLBACK_RATES, fingerprint: fp("SE"), learnedSoldPerSearch: new Map([["SE", 2.5]]),
    });
    assert.equal(report.stopReason, "target");
    assert.deepEqual(report.tiersUsed, ["local"]);
    assert.ok(report.findings.every((f) => f.tier === "local" && f.origin === "SE"));
    assert.ok(seen.every((g) => g === "se"));
  });

  it("Sweden without any statistics is thin: a global search runs from the very first request", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps(async (call) => {
      seen.push(`${call.body?.gl}`);
      return call.body?.gl === "se" ? sold("www.tradera.com", 5, 100, "t") : sold("www.ebay.com", 3, 110, "u");
    });
    const report = await runMarketLive(deps, testConfig(), plan(), { budgetMs: 2000, rates: FALLBACK_RATES, fingerprint: fp("SE") });
    assert.ok(seen.includes("us"), "a US search was started next to the local ones");
    assert.ok(report.findings.some((f) => f.tier === "global"), "so foreign comparables exist for the price level to learn from");
  });

  it("a thin country starts a global search in the same breath, not after the local ones fail", async () => {
    const starts: { gl: string; at: number }[] = [];
    const t0 = Date.now();
    const { deps } = makeDeps(async (call, signal) => {
      starts.push({ gl: String(call.body?.gl), at: Date.now() - t0 });
      await sleepMs(150, signal);
      return empty();
    });
    const p = plan();
    await runMarketLive(deps, testConfig(), p, { budgetMs: 2000, rates: FALLBACK_RATES, fingerprint: fp("FI", "fi") });
    const firstGlobal = starts.find((s) => s.gl === "us")!;
    assert.ok(firstGlobal, "a global search was made");
    assert.ok(firstGlobal.at < 100, `global started with wave 1, not later (started at ${firstGlobal.at} ms)`);
  });

  it("without a fingerprint it behaves as before: the plan runs, everything is local", async () => {
    const { deps } = makeDeps(async () => sold("www.ebay.com", 5, 90, "e"));
    const report = await runMarketLive(deps, testConfig(), plan(), { budgetMs: 2000, rates: FALLBACK_RATES });
    assert.equal(report.stopReason, "target");
    assert.ok(report.findings.every((f) => f.tier === "local"));
  });

  it("local listings are listed before foreign ones of the same kind", () => {
    const mk = (tier: "local" | "regional" | "global", i: number) => ({ searchId: "s1", title: `t${i}`, snippet: "", url: `https://x.com/${i}`, site: "x.com", kind: "sold" as const, price: 10, currency: "USD", priceUsd: 10, gl: "se", origin: "SE", tier });
    const out = selectFindings([mk("global", 1), mk("local", 2), mk("regional", 3)]);
    assert.deepEqual(out.map((f) => f.tier), ["local", "regional", "global"]);
  });
});

describe("Identification writes local queries", () => {
  it("names the language, the word for sold and the local marketplaces", () => {
    const se = localQueryGuide("SE");
    assert.match(se, /Swedish/);
    assert.match(se, /såld slutpris/);
    assert.match(se, /tradera\.com/);
    assert.match(localQueryGuide("DE"), /German[\s\S]*verkauft[\s\S]*ebay\.de/);
    assert.match(localQueryGuide("JP"), /Japanese/);
  });
  it("an English market and an unknown country stay in English", () => {
    assert.match(localQueryGuide("GB"), /English/);
    assert.match(localQueryGuide(null), /unknown[\s\S]*English/);
    assert.match(localQueryGuide("ZZ"), /English/);
  });
});

describe("Memory never shows a foreign price as a local one", () => {
  const cfg = testConfig();
  const stored = (country: string) =>
    storedValuation({}, { market: { country, basis: "local", local: 5, regional: 0, global: 0 } });
  it("a Swedish valuation does not answer a German user", () => {
    assert.equal(isUsableHit(stored("SE"), cfg, Date.now(), "DE"), false);
    assert.equal(isUsableHit(stored("SE"), cfg, Date.now(), "SE"), true);
  });
  it("a valuation that does not say which market it belongs to is no longer trusted (the strict rule, brain 4.1)", () => {
    const old = storedValuation({}, { market: undefined });
    assert.equal(isUsableHit(old, cfg, Date.now(), "SE"), false);
  });
  it("evidence from far away (global) is never reused, whoever asks", () => {
    const far = storedValuation({}, { market: { country: "SE", basis: "global", local: 0, regional: 0, global: 5 } });
    assert.equal(isUsableHit(far, cfg, Date.now(), "SE"), false);
  });
});

describe("prices from more countries", () => {
  it("reads Hungarian, Romanian and Icelandic money, and does not mistake feet for forint", () => {
    assert.deepEqual(extractMoney("Sold 45 000 HUF"), [{ price: 45000, currency: "HUF" }]);
    assert.deepEqual(extractMoney("RON 1.250"), [{ price: 1250, currency: "RON" }]);
    assert.deepEqual(extractMoney("Selt 25.000 kr", { host: "bland.is", gl: "is" }), [{ price: 25000, currency: "ISK" }]);
    assert.deepEqual(extractMoney("a 10 ft pole"), []);
  });
});
