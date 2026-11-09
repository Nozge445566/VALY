import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIXED_TEMPLATES, fixedPlan } from "../fixed-templates.ts";
import { PLAN_BUDGET_MS, planSearches } from "../search-ai.ts";
import type { LocalPlanFn } from "../search-ai.ts";
import type { Fingerprint } from "../types.ts";
import { fakeEngine, json, makeDeps, sleepMs, testConfig } from "./helpers.ts";

const fp: Fingerprint = { category: "watch", brand: "seiko", type: "automatic wristwatch", model: "snk809", era: "2010s", country: "SE", language: "sv" };

const goodPlan = {
  ok: true, strategy_version: 4,
  searches: [
    { id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" },
    { id: "s2", query: "seiko snk809 såld", template_id: "fx_local_sold", kind: "experiment", gl: "se", hl: "sv" },
  ],
  stop: { sold_prices: 5, max_ms: 2000 },
};

// The engine runs inside the Edge Function, so there is no network here: every test hands planSearches a fake engine.
const planWith = (engine: LocalPlanFn, queries: string[] = [], budgetMs?: number) => {
  const { deps, calls } = makeDeps(() => json({}, 404));
  return planSearches(deps, testConfig(), fp, queries, engine, budgetMs).then((r) => ({ r, calls }));
};

describe("planSearches", () => {
  it("uses the Search AI plan when it is valid, and gives the engine the fingerprint and the queries", async () => {
    const seen: unknown[][] = [];
    const engine: LocalPlanFn = async (...args) => { seen.push(args); return goodPlan; };
    const { r, calls } = await planWith(engine, ["q one"]);
    assert.equal(r.fallbackReason, null);
    assert.equal(r.plan.source, "search_ai");
    assert.equal(r.plan.strategyVersion, 4);
    assert.deepEqual(seen, [[fp, ["q one"]]]);
    assert.equal(calls.length, 0, "the engine is in-process: no network call is made");
  });

  it("falls back to the fixed templates when the engine fails, and says why (search_ai_engine_error)", async () => {
    const { r } = await planWith(fakeEngine({ ok: false, reason: "engine_error" }));
    assert.equal(r.fallbackReason, "search_ai_engine_error");
    assert.equal(r.plan.source, "fixed");
    assert.equal(r.plan.strategyVersion, null);
  });

  it("falls back when the Search AI has no data, and keeps the reason it gave", async () => {
    const { r } = await planWith(fakeEngine({ ok: false, reason: "no_data" }));
    assert.equal(r.fallbackReason, "search_ai_no_data");
    assert.equal(r.plan.source, "fixed");
  });

  it("cleans the reason the engine gives before it becomes a fallback label", async () => {
    assert.equal((await planWith(fakeEngine({ ok: false, reason: "No Data!! \n x" }))).r.fallbackReason, "search_ai_nodatax");
    assert.equal((await planWith(fakeEngine({ ok: false }))).r.fallbackReason, "search_ai_declined");
    assert.equal((await planWith(fakeEngine({ ok: false, reason: "!!!" }))).r.fallbackReason, "search_ai_declined");
    assert.equal((await planWith(fakeEngine({ ok: false, reason: "a".repeat(80) }))).r.fallbackReason, `search_ai_${"a".repeat(30)}`);
  });

  it("falls back when the engine answers with an invalid plan", async () => {
    for (const bad of [{ ok: true, searches: "nope" }, { ok: true, strategy_version: 1, searches: [] }, {}, null, "plan"]) {
      const { r } = await planWith(fakeEngine(bad as never));
      assert.equal(r.fallbackReason, "search_ai_invalid", JSON.stringify(bad));
      assert.equal(r.plan.source, "fixed");
    }
  });

  it("falls back when the engine throws (also when it throws before it returns a promise)", async () => {
    const a = await planWith(fakeEngine(() => { throw new Error("boom"); }));
    assert.equal(a.r.fallbackReason, "search_ai_error");
    const sync: LocalPlanFn = () => { throw new Error("sync boom"); };
    const b = await planWith(sync);
    assert.equal(b.r.fallbackReason, "search_ai_error");
    assert.equal(b.r.plan.source, "fixed");
  });

  it("falls back to the fixed templates when the engine is slow, and does not wait for it", async () => {
    const slow = fakeEngine(async () => { await sleepMs(3000); return goodPlan; });
    const { r } = await planWith(slow, [], 150);
    assert.equal(r.fallbackReason, "search_ai_slow");
    assert.equal(r.plan.source, "fixed");
    assert.ok(r.ms >= 100 && r.ms < 600, `took ${r.ms} ms`);
  });

  it("has a default budget of 400 ms, so a slow engine can never eat the Judge's time", async () => {
    assert.equal(PLAN_BUDGET_MS, 400);
    const slow = fakeEngine(async () => { await sleepMs(900); return goodPlan; });
    const { r } = await planWith(slow);
    assert.equal(r.fallbackReason, "search_ai_slow");
    assert.ok(r.ms < 700, `took ${r.ms} ms`);
  });

  it("a plan that arrives inside the budget is used", async () => {
    const quick = fakeEngine(async () => { await sleepMs(30); return goodPlan; });
    const { r } = await planWith(quick, [], 400);
    assert.equal(r.fallbackReason, null);
    assert.equal(r.plan.source, "search_ai");
  });

  it("a late failure of a slow engine is not an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const slowThenBroken = fakeEngine(async () => { await sleepMs(120); throw new Error("late boom"); });
      const { r } = await planWith(slowThenBroken, [], 30);
      assert.equal(r.fallbackReason, "search_ai_slow");
      await sleepMs(250);
      assert.deepEqual(rejections, []);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("the fallback plan is the same fixed plan whatever the reason", async () => {
    const expected = fixedPlan(fp, ["q one"]);
    for (const answer of [{ ok: false, reason: "no_data" }, { ok: true, searches: "x" }]) {
      const { r } = await planWith(fakeEngine(answer), ["q one"]);
      assert.deepEqual(r.plan, expected);
    }
  });
});

describe("fixedPlan", () => {
  it("makes at most 4 distinct searches, mixing global and local", () => {
    const p = fixedPlan(fp, ["seiko snk809 chrono24"]);
    assert.ok(p.searches.length >= 3 && p.searches.length <= 4);
    assert.equal(new Set(p.searches.map((s) => s.query)).size, p.searches.length);
    assert.ok(p.searches.some((s) => s.gl === "us"));
    assert.ok(p.searches.some((s) => s.gl === "se" && s.hl === "sv"));
    assert.ok(p.searches.every((s) => s.kind === "fixed"));
    assert.equal(p.strategyVersion, null);
    assert.equal(p.stop.soldPrices, 5);
    assert.equal(p.stop.maxMs, 2000);
  });

  it("still works for an item without brand and model", () => {
    const p = fixedPlan({ ...fp, brand: null, model: null, type: "hand axe", category: "axe" }, ["old hand axe sold"]);
    assert.ok(p.searches.length >= 2);
    assert.ok(p.searches.every((s) => s.query.length >= 3));
  });

  it("has templates with unique ids", () => {
    assert.equal(new Set(FIXED_TEMPLATES.map((t) => t.id)).size, FIXED_TEMPLATES.length);
  });
});
