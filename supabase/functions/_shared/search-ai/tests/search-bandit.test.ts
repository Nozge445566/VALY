// Phase 1B: bandit posterior (hand-checked numbers) and Gamma sampler statistics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gammaSample, posterior, sample } from "../bandit.ts";
import { emptyPolicy } from "../policy.ts";

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("posterior: empty policy gives the prior", () => {
  const p = posterior(emptyPolicy(), ["g", "c"], "t1");
  assert.ok(Math.abs(p.alpha - 2.4) < 1e-12 && Math.abs(p.beta - 6) < 1e-12);
  assert.equal(p.nGlobal, 0);
});

test("posterior: shrinkage by hand (+k, +t, mean carried down)", () => {
  const p = emptyPolicy(1);
  p.arms.set("g", new Map([["t1", [6, 10, 20]]]));
  p.arms.set("c", new Map([["t1", [3, 4, 7]]]));
  const r = posterior(p, ["g", "c"], "t1");
  // g: alpha=2.4+6=8.4, beta=16, mu=0.525. c: alpha=0.525*6+3=6.15, beta=10
  assert.ok(Math.abs(r.alpha - 6.15) < 1e-12, String(r.alpha));
  assert.ok(Math.abs(r.beta - 10) < 1e-12);
  assert.equal(r.nGlobal, 20);
  assert.equal(r.nSpecific, 7);
});

for (const [alpha, beta] of [[0.3, 1], [0.8, 2], [0.999, 1], [1, 1], [1.001, 3], [2.4, 6], [10, 0.5], [150, 2]]) {
  test(`gamma stats alpha=${alpha} beta=${beta}`, () => {
    const rng = mulberry(12345);
    const N = 200000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) {
      const x = sample({ alpha, beta, nGlobal: 0, nSpecific: 0 }, rng);
      assert.ok(x >= 0 && Number.isFinite(x));
      s += x;
      s2 += x * x;
    }
    const mean = s / N;
    const variance = s2 / N - mean * mean;
    assert.ok(Math.abs(mean / (alpha / beta) - 1) < 0.02, `mean ${mean}`);
    assert.ok(Math.abs(variance / (alpha / (beta * beta)) - 1) < 0.05, `var ${variance}`);
  });
}

test("gammaSample is deterministic with a seeded rng", () => {
  assert.equal(gammaSample(2.5, mulberry(7)), gammaSample(2.5, mulberry(7)));
});
