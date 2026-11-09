// The call-site edge of the Search AI (local-engine.ts): the only place that touches Math.random, the clock and the
// environment. It must NEVER throw, and with no database it must say "no data" instead of guessing.
// Nothing here uses the network: the environment is empty, so the engine has no database to read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, describe, it, mock } from "node:test";
import { getHolder, localPlan, resetHolderForTests } from "../local-engine.ts";
import { policyFromJson } from "../policy.ts";
import { planSearches } from "../../../value-item/search-ai.ts";
import { json, makeDeps, testConfig } from "../../../value-item/tests/helpers.ts";

const noEnv = () => undefined;
const golden = JSON.parse(readFileSync(new URL("./golden/planner.json", import.meta.url), "utf8")) as {
  cases: Array<{ raw: Record<string, string>; ident: string[]; version: number; policy: unknown; out: { ok: boolean } }>;
};
const good = golden.cases.find((c) => c.out.ok)!;

describe("localPlan (the in-process Search AI)", () => {
  beforeEach(() => resetHolderForTests());
  after(() => resetHolderForTests());

  it("says no_data when there is no database and no learned strategy yet", async () => {
    assert.deepEqual(await localPlan(good.raw, good.ident, noEnv), { ok: false, reason: "no_data" });
  });

  it("keeps one holder between calls, until it is reset", () => {
    const a = getHolder(noEnv);
    assert.equal(getHolder(noEnv), a);
    resetHolderForTests();
    assert.notEqual(getHolder(noEnv), a);
  });

  it("plans with the learned strategy it holds (real engine, real randomness)", async () => {
    getHolder(noEnv).policy = policyFromJson(good.version, good.policy);
    for (let i = 0; i < 20; i++) {
      const out = await localPlan(good.raw, good.ident, noEnv) as { ok: boolean; strategy_version: number; searches: unknown[] };
      assert.equal(out.ok, true);
      assert.equal(out.strategy_version, good.version);
      assert.ok(out.searches.length >= 1 && out.searches.length <= 4);
    }
  });

  it("never throws: trouble inside the engine becomes engine_error", async () => {
    const log = mock.method(console, "warn", () => undefined);
    try {
      const hostile = { get category(): string { throw new Error("boom"); } };
      assert.deepEqual(await localPlan(hostile, [], noEnv), { ok: false, reason: "engine_error" });
      assert.equal(log.mock.callCount(), 1);
      assert.match(String(log.mock.calls[0].arguments[0]), /local plan failed: boom/);
    } finally {
      log.mock.restore();
    }
  });

  it("bad input is declined, not thrown", async () => {
    getHolder(noEnv).policy = policyFromJson(good.version, good.policy);
    for (const bad of [null, undefined, 5, "x", [], {}]) {
      assert.deepEqual(await localPlan(bad, [], noEnv), { ok: false, reason: "bad_input" });
    }
  });
});

describe("planSearches with the real engine (its default)", () => {
  beforeEach(() => resetHolderForTests());
  after(() => resetHolderForTests());

  it("uses the learned strategy the holder has, with no network call", async () => {
    getHolder(noEnv).policy = policyFromJson(good.version, good.policy);
    const { deps, calls } = makeDeps(() => json({}, 404));
    const r = await planSearches(deps, testConfig(), good.raw as never, good.ident);
    assert.equal(r.fallbackReason, null);
    assert.equal(r.plan.source, "search_ai");
    assert.equal(r.plan.strategyVersion, good.version);
    assert.equal(calls.length, 0);
  });

  it("falls back to the fixed templates when nothing is learned yet", async () => {
    getHolder(noEnv); // an empty holder, no database
    const { deps } = makeDeps(() => json({}, 404));
    const r = await planSearches(deps, testConfig(), good.raw as never, good.ident);
    assert.equal(r.fallbackReason, "search_ai_no_data");
    assert.equal(r.plan.source, "fixed");
  });
});
