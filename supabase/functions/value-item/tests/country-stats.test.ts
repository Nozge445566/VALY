// Country adaptation, part 2 (Edge Function side): the numbers the nightly learner measures reach
// Market Live without ever delaying an answer, and the Search AI's `tier` passes validation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../handler.ts";
import { COUNTRY_STATS_MIN_N, isThinData, learnedSoldPerSearch, parseCountryStats } from "../market-tiers.ts";
import { DEFAULT_LIMITS } from "../protection.ts";
import { validateSearchPlan } from "../validate.ts";
import {
  FAKE_DATA_URL, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, fakeStore, json, makeDeps, sampleVerdict, serperSold, stepOf, streamJudge,
  testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

// ---------------------------------------------------------------- the pure part

describe("country statistics from the learner", () => {
  it("reads the learner's JSON and skips anything malformed", () => {
    const stats = parseCountryStats({
      SE: { sold_per_search: 1.9, n: 412 },
      de: { sold_per_search: 2, n: 50 }, // lower-case key: not a country code
      ZZ: { sold_per_search: 9, n: 999 }, // unknown country has no local market
      NO: { sold_per_search: "many", n: 40 },
      DK: { sold_per_search: -1, n: 40 },
      FI: { sold_per_search: 0.4, n: 12.5 },
      PL: null,
    });
    assert.deepEqual(stats, [{ country: "SE", soldPerSearch: 1.9, n: 412 }]);
    assert.deepEqual(parseCountryStats(null), []);
    assert.deepEqual(parseCountryStats([1, 2]), []);
    assert.deepEqual(parseCountryStats("x"), []);
  });

  it("a figure is trusted only from the minimum number of searches", () => {
    const map = learnedSoldPerSearch([
      { country: "SE", soldPerSearch: 1.9, n: COUNTRY_STATS_MIN_N },
      { country: "NO", soldPerSearch: 2.5, n: COUNTRY_STATS_MIN_N - 1 },
    ]);
    assert.equal(map.get("SE"), 1.9);
    assert.equal(map.has("NO"), false);
  });

  it("the learned map overrides the starting list in both directions", () => {
    assert.equal(isThinData("PL"), true); // not on the starting list
    assert.equal(isThinData("PL", learnedSoldPerSearch([{ country: "PL", soldPerSearch: 2.2, n: 80 }])), false);
    assert.equal(isThinData("DE"), false); // on the starting list
    assert.equal(isThinData("DE", learnedSoldPerSearch([{ country: "DE", soldPerSearch: 0.3, n: 80 }])), true);
  });
});

// ---------------------------------------------------------------- the plan's tier

describe("validateSearchPlan and the optional tier", () => {
  const plan = (tier?: unknown) => ({
    ok: true, strategy_version: 3,
    searches: [{ id: "s1", query: "seiko snk809 sold", template_id: "fx_local_sold", kind: "exploit", gl: "se", hl: "sv", ...(tier === undefined ? {} : { tier }) }],
    stop: { sold_prices: 5, max_ms: 2000 },
  });

  it("passes the tier through", () => {
    const v = validateSearchPlan(plan("regional"));
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.value.searches[0].tier, "regional");
  });

  it("a plan without a tier (older Search AI) still works and has no tier key", () => {
    const v = validateSearchPlan(plan());
    assert.equal(v.ok, true);
    if (v.ok) assert.equal("tier" in v.value.searches[0], false);
  });

  it("null counts as absent; an unknown tier is refused", () => {
    assert.equal(validateSearchPlan(plan(null)).ok, true);
    const bad = validateSearchPlan(plan("far-away"));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.errors.some((e) => e.includes("tier")));
  });
});

// ---------------------------------------------------------------- through the handler

const PLAN_PL = {
  ok: true, strategy_version: 2,
  searches: [{ id: "s1", query: "seiko snk809 sprzedane", template_id: "fx_local_sold", kind: "exploit", gl: "pl", hl: "pl" }],
  stop: { sold_prices: 5, max_ms: 2000 },
};

const route: Route = async (call: Call, signal?: AbortSignal) => {
  if (call.url.includes("anthropic")) {
    const s = stepOf(call);
    if (s === "detail") return claudeReply(SAMPLE_DETAILS);
    if (s === "auth") return claudeReply(SAMPLE_AUTH);
    if (s === "ident") return claudeReply(SAMPLE_IDENT);
    return streamJudge(sampleVerdict(), signal);
  }
  if (call.url.includes("serper")) return serperSold(5, 60, "p", "allegro.pl"); // five local sold prices at once
  return json({}, 404);
};

async function ask(store = fakeStore(), country = "PL") {
  const { deps, calls, clock } = makeDeps(route);
  const bg: Promise<unknown>[] = [];
  const ctx = {
    getConfig: () => testConfig(),
    store, deps, limits: DEFAULT_LIMITS, background: (p: Promise<unknown>) => { bg.push(p); },
    localPlan: fakeEngine(PLAN_PL, { calls, clock }),
  };
  const req = new Request("https://x.test/functions/v1/value-item", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: FAKE_DATA_URL, deviceId: "device-0123456789abcdef", currency: "USD", country }),
  });
  const res = await handleRequest(req, ctx);
  await Promise.all(bg);
  const globalSearches = calls.filter((c) => c.url.includes("serper") && c.body?.gl === "us").length;
  return { res, store, calls, globalSearches };
}

describe("the learner's country statistics in a real request", () => {
  it("without statistics a country off the starting list is thin: a global search starts at once", async () => {
    const { res, globalSearches } = await ask();
    assert.equal(res.status, 200);
    assert.ok(globalSearches >= 1);
  });

  it("measured data says the country is rich: no extra global search", async () => {
    const store = fakeStore();
    store.countryStats = [{ country: "PL", soldPerSearch: 2.4, n: 120 }];
    const { res, globalSearches } = await ask(store);
    assert.equal(res.status, 200);
    assert.equal(globalSearches, 0);
    assert.equal(store.countryStatsCalls, 1);
  });

  it("a figure built on too few searches is not trusted", async () => {
    const store = fakeStore();
    store.countryStats = [{ country: "PL", soldPerSearch: 2.4, n: 10 }];
    const { globalSearches } = await ask(store);
    assert.ok(globalSearches >= 1);
  });

  it("is read once, then served from the 10 minute cache", async () => {
    const store = fakeStore();
    await ask(store);
    await ask(store);
    assert.equal(store.countryStatsCalls, 1);
  });

  it("a failing read never breaks the answer: the starting list is used", async () => {
    const store = fakeStore();
    store.loadCountryStats = async () => { throw new Error("db down"); };
    const { res, globalSearches } = await ask(store);
    assert.equal(res.status, 200);
    assert.ok(globalSearches >= 1);
  });

  it("a read that never answers does not delay the answer", async () => {
    const store = fakeStore();
    store.loadCountryStats = () => new Promise(() => undefined);
    const t0 = Date.now();
    const { res } = await ask(store);
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 3000, "answered without waiting for the statistics");
  });

  it("an unknown country is never thin, whatever the table says", async () => {
    const store = fakeStore();
    store.countryStats = [{ country: "PL", soldPerSearch: 0.1, n: 500 }];
    const { res, globalSearches } = await ask(store, "ZZ");
    assert.equal(res.status, 200);
    assert.equal(globalSearches, 0);
  });
});

// ---------------------------------------------------------------- is the starting list right?

import { assumptionCheck, DATA_RICH } from "../market-tiers.ts";

describe("assumptionCheck: the starting list is checked against what was measured", () => {
  const stat = (country: string, soldPerSearch: number, n: number) => ({ country, soldPerSearch, n });

  it("Sweden is no longer assumed rich", () => {
    assert.equal(DATA_RICH.has("SE"), false);
    assert.equal(assumptionCheck([]).find((r) => r.country === "SE"), undefined, "no stats and not on the list: not reported");
    assert.equal(assumptionCheck([stat("SE", 0.3, 5)]).find((r) => r.country === "SE")!.assumed, "thin");
  });

  it("no data, waiting, confirmed and contradicted are told apart", () => {
    const rows = assumptionCheck([
      stat("DE", 2.2, 120), // listed rich, measured rich: confirmed
      stat("FR", 0.4, 90), // listed rich, measured thin: contradicted
      stat("SE", 0.3, 55), // not listed, measured thin: confirmed
      stat("NO", 2.0, 40), // not listed, measured rich: contradicted
      stat("JP", 0.2, 12), // too few searches: waiting
    ]);
    const get = (c: string) => rows.find((r) => r.country === c)!;
    assert.equal(get("DE").status, "confirmed");
    assert.equal(get("FR").status, "contradicted");
    assert.equal(get("SE").status, "confirmed");
    assert.equal(get("NO").status, "contradicted");
    assert.equal(get("JP").status, "waiting");
    assert.equal(get("US").status, "no_data");
    assert.equal(rows[0].country, "DE", "most searches first");
  });

  it("the same threshold as isThinData: a figure exactly at the limit counts as rich", () => {
    const rows = assumptionCheck([stat("DE", 1.2, COUNTRY_STATS_MIN_N)]);
    assert.equal(rows.find((r) => r.country === "DE")!.status, "confirmed");
  });
});
