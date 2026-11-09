import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFusedInterval, fusionAdsOf } from "../fused-interval.ts";
import type { IntervalInput, RawComp } from "../interval.ts";

const comps = (n: number, base = 100, kind: "sold" | "asking" = "sold"): RawComp[] =>
  Array.from({ length: n }, (_, i) => ({ priceUsd: base * (1 + ((i % 5) - 2) * 0.02), kind, match: "same" as const, tier: "local" as const }));
const base = (over: Partial<IntervalInput> = {}): IntervalInput => ({
  model: { low: 80, mid: 100, high: 120 }, modelConfidence: 70, comps: comps(8), category: "electronics", condition: "good",
  authenticityRisk: "low", unknownsCount: 1, ...over,
});

describe("fused-interval.ts", () => {
  it("is ordered, finite, deterministic, and confidence comes only from the width (5-95)", () => {
    const a = buildFusedInterval(base()), b = buildFusedInterval(base());
    assert.deepEqual(a, b);
    assert.ok(a.low > 0 && a.low < a.mid && a.mid < a.high);
    assert.ok(a.confidenceScore >= 5 && a.confidenceScore <= 95);
    assert.ok(Math.abs(a.mid - 100) < 6, String(a.mid));
  });
  it("more risk widens only the LOW side, once", () => {
    const lo = buildFusedInterval(base({ authenticityRisk: "low" })), hi = buildFusedInterval(base({ authenticityRisk: "high" }));
    assert.ok(hi.low < lo.low);
    assert.ok(Math.abs(hi.high - lo.high) / lo.high < 1e-9);
    assert.ok(hi.confidenceScore <= lo.confidenceScore);
  });
  it("scattered ads give a wider range and lower confidence than tight ads", () => {
    const wide = buildFusedInterval(base({ comps: [60, 140, 90, 120, 200, 50, 100, 150].map((p) => ({ priceUsd: p, kind: "sold" as const, match: "same" as const })) }));
    const tight = buildFusedInterval(base());
    assert.ok(wide.high / wide.low > tight.high / tight.low);
    assert.ok(wide.confidenceScore < tight.confidenceScore);
  });
  it("an independent source that contradicts the ads does not drag the price and is flagged", () => {
    const withBad = buildFusedInterval({ ...base(), sources: [{ name: "judge_a", mu: Math.log(900), sd: 0.3 }] });
    assert.ok(withBad.mid < 130, String(withBad.mid));
    assert.ok(withBad.widthDrivers.includes("sources_disagree") || withBad.confidenceScore < buildFusedInterval(base()).confidenceScore);
  });
  it("no ads: uses the anchor source, flags model_only, confidence capped like the old no-market path", () => {
    const r = buildFusedInterval(base({ comps: [], sources: [{ name: "judge_a", mu: Math.log(90), sd: 0.5 }] }));
    assert.ok(Math.abs(r.mid - 90) < 1);
    assert.ok(r.widthDrivers.includes("model_only"));
    assert.ok(r.confidenceScore <= 40);
  });
  it("no ads and no source: falls back to the verdict's own range", () => {
    const r = buildFusedInterval(base({ comps: [] }));
    assert.ok(Math.abs(r.mid - 100) < 1e-6);
    assert.ok(r.low < r.mid && r.mid < r.high);
  });
  it("fusionAdsOf: asking prices sit at sold level, foreign ads are noisier, bad prices are dropped", () => {
    const [s, a, fgn] = fusionAdsOf([
      { priceUsd: 100, kind: "sold", match: "same", tier: "local" },
      { priceUsd: 100, kind: "asking", match: "same", tier: "local" },
      { priceUsd: 100, kind: "sold", match: "same", tier: "global" },
      { priceUsd: NaN, kind: "sold" }, { priceUsd: -5, kind: "sold" },
    ]);
    assert.equal(fusionAdsOf([{ priceUsd: NaN, kind: "sold" }]).length, 0);
    assert.ok(a.y < s.y && a.se2 > s.se2);
    assert.ok(fgn.se2 > s.se2);
  });
});

describe("fused-interval.ts: foreign data (ported from the removed old engine's tests)", () => {
  const mk = (extra: Partial<RawComp> = {}): RawComp[] => comps(8, 100).map((c) => ({ ...c, tier: "global" as const, ...extra }));
  it("a learned negative shift lowers the centre; local ads are never shifted", () => {
    const plain = buildFusedInterval(base({ comps: mk() }));
    const shifted = buildFusedInterval(base({ comps: mk({ shiftLn: -0.2 }) }));
    assert.ok(shifted.mid < plain.mid * 0.9, `${shifted.mid} vs ${plain.mid}`);
    const local = buildFusedInterval(base({ comps: comps(8, 100).map((c) => ({ ...c, shiftLn: -0.2 })) }));
    assert.ok(Math.abs(local.mid - buildFusedInterval(base()).mid) < 1e-9);
  });
  it("wider learned noise widens the range, a narrower one cannot narrow it below the guess", () => {
    const g = buildFusedInterval(base({ comps: mk() }));
    const wide = buildFusedInterval(base({ comps: mk({ extraStd: 0.3 }) }));
    const narrow = buildFusedInterval(base({ comps: mk({ extraStd: 0.01 }) }));
    assert.ok(Math.log(wide.high / wide.low) > Math.log(g.high / g.low));
    assert.ok(Math.abs(Math.log(narrow.high / narrow.low) - Math.log(g.high / g.low)) < 1e-9);
  });
  it("calibration multiplier k scales the width and is clamped", () => {
    const w = (k: number) => { const r = buildFusedInterval(base({ k })); return Math.log(r.high / r.low); };
    assert.ok(w(1.5) > w(1) && w(1) > w(0.8));
    assert.ok(Math.abs(w(1000) - w(5)) < 1e-9 || w(1000) <= w(5) * 3);
  });
  it("more foreign ads lower the score and the breakdown reports the basis", () => {
    const l = buildFusedInterval(base()), g = buildFusedInterval(base({ comps: mk() }));
    assert.ok(g.confidenceScore <= l.confidenceScore);
    assert.equal(g.breakdown.basis, "global");
    assert.equal(l.breakdown.basis, "local");
  });
});
