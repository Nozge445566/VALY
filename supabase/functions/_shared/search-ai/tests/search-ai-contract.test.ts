// The Search AI engine and the Edge Function are two parts that must agree on the shape of a plan.
// Both are TypeScript now and run in the same process. These tests run the REAL engine (planner.ts) on the real
// policies recorded in golden/planner.json, so a change on one side that breaks the other is caught.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { plan } from "../planner.ts";
import { policyFromJson } from "../policy.ts";
import { HARD_CAPS } from "../../../value-item/config.ts";
import { planSearches } from "../../../value-item/search-ai.ts";
import { validateSearchPlan } from "../../../value-item/validate.ts";
import { json, makeDeps, testConfig } from "../../../value-item/tests/helpers.ts";

interface GoldenCase { raw: unknown; ident: unknown; version: number; policy: unknown; out: { ok: boolean; searches?: unknown[] } }
const golden = JSON.parse(readFileSync(new URL("./golden/planner.json", import.meta.url), "utf8")) as { cases: GoldenCase[] };
const okCases = golden.cases.filter((c) => c.out.ok);

// A seeded random source: the same plans every run (the engine itself is never given Math.random here).
function seeded(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

describe("the Search AI engine and the Edge Function agree", () => {
  it("has real cases to check", () => {
    assert.ok(okCases.length >= 500, `only ${okCases.length} planning cases`);
  });

  it("every plan the engine makes passes the Edge Function's validation", () => {
    const rng = seeded(2026);
    for (const c of okCases) {
      const out = plan(policyFromJson(c.version, c.policy), c.raw, c.ident, rng);
      const v = validateSearchPlan(out);
      assert.equal(v.ok, true, `${JSON.stringify(c.raw)}: ${v.ok ? "" : v.errors.join("; ")}`);
      if (v.ok) {
        assert.equal(v.value.source, "search_ai");
        assert.equal(v.value.strategyVersion, c.version);
        assert.ok(v.value.searches.length >= 1 && v.value.searches.length <= HARD_CAPS.searches);
      }
    }
  });

  it("every search in an engine plan carries a tier the Edge Function accepts", () => {
    const rng = seeded(7);
    const seen = new Set<string>();
    for (const c of okCases) {
      const v = validateSearchPlan(plan(policyFromJson(c.version, c.policy), c.raw, c.ident, rng));
      assert.equal(v.ok, true);
      if (v.ok) for (const s of v.value.searches) {
        assert.ok(s.tier === "local" || s.tier === "regional" || s.tier === "global", `tier ${String(s.tier)}`);
        seen.add(String(s.tier));
      }
    }
    assert.ok(seen.has("local") && seen.has("global"), "the cases cover both ends of the ladder");
  });

  it("planSearches takes an engine plan as it is: source search_ai, no fallback", async () => {
    const rng = seeded(11);
    for (const c of okCases.slice(0, 100)) {
      const { deps } = makeDeps(() => json({}, 404));
      const engine = async (f: unknown, q: unknown) => plan(policyFromJson(c.version, c.policy), f, q, rng);
      const fp = { ...(c.raw as Record<string, string>) } as never;
      const r = await planSearches(deps, testConfig(), fp, (c.ident as string[]) ?? [], engine);
      assert.equal(r.fallbackReason, null, JSON.stringify(c.raw));
      assert.equal(r.plan.source, "search_ai");
    }
  });

  it("when the engine has no data, planSearches uses the fixed templates and says so", async () => {
    const empty = policyFromJson(0, { schema: 1, arms: {} });
    const rng = seeded(3);
    const { deps } = makeDeps(() => json({}, 404));
    const fp = { category: "watch", brand: "seiko", type: "automatic wristwatch", model: "snk809", era: "2010s", country: "SE", language: "sv" };
    const r = await planSearches(deps, testConfig(), fp, [], async (f, q) => plan(empty, f, q, rng));
    assert.equal(r.fallbackReason, "search_ai_no_data");
    assert.equal(r.plan.source, "fixed");
  });
});
