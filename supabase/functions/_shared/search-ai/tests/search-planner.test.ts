// Phase 2 gate: the TypeScript planner must equal the Python planner (deterministic draw stream).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { plan, globalBudget, MAX_SEARCHES, type Sampler } from "../planner.ts";
import { policyFromJson } from "../policy.ts";
import { cleanFingerprint } from "../fingerprint.ts";

const g = JSON.parse(readFileSync(new URL("./golden/planner.json", import.meta.url), "utf8"));

// Same stream as FakeRng in make_golden.py (BigInt: x * 1103515245 exceeds 2^53).
function fakeSampler(seed: number): Sampler {
  let x = BigInt(seed) % 2147483648n;
  return (p) => {
    x = (x * 1103515245n + 12345n) % 2147483648n;
    const u = Number(x) / 2147483648;
    return p.alpha * (1 / p.beta) * (0.2 + 1.6 * u);
  };
}
const never = () => { throw new Error("rng must not be used with the fake sampler"); };

test("golden coverage", () => {
  const ok = g.cases.filter((c: any) => c.out.ok).length;
  assert.ok(ok >= 500 && g.cases.length - ok >= 50);
  const kinds = new Set(g.cases.flatMap((c: any) => (c.out.searches ?? []).map((s: any) => s.kind)));
  assert.deepEqual([...kinds].sort(), ["experiment", "exploit"]);
  const tiers = new Set(g.cases.flatMap((c: any) => (c.out.searches ?? []).map((s: any) => s.tier)));
  assert.ok(tiers.has("global") && tiers.has("local"));
});
test("bad input and no data", () => {
  for (const e of g.extra) assert.deepEqual(plan(policyFromJson(e.version, { schema: 1, arms: {} }), e.raw, [], never, fakeSampler(1)), e.out);
});
