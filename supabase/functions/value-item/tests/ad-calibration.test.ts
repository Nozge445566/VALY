import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adNoise, variantAmbiguityOf, P_SAME_SE2 } from "../ad-calibration.ts";
import { buildFusedInterval } from "../fused-interval.ts";

describe("ad calibration table", () => {
  it("coarse labels reproduce the old placeholders exactly", () => {
    assert.equal(adNoise({ match: "same", asking: false }), 0.03);
    assert.equal(adNoise({ match: "similar", asking: false }), 0.12);
    assert.ok(Math.abs((adNoise({ match: "same", asking: true }) as number) - 0.05) < 1e-12);
  });
  it("band `no` and unknown labels are dropped; low reliability widens; output bounded and finite", () => {
    assert.equal(adNoise({ pSame: "no", asking: false }), null);
    assert.equal(adNoise({ match: "different", asking: false }), null);
    assert.ok((adNoise({ pSame: "likely", reliability: "low", asking: true }) as number) > (adNoise({ pSame: "likely", asking: true }) as number));
    for (const b of Object.keys(P_SAME_SE2) as (keyof typeof P_SAME_SE2)[]) { const v = adNoise({ pSame: b, reliability: "low", asking: true }); assert.ok(v == null || (Number.isFinite(v) && v <= 0.6)); }
  });
  it("variant ambiguity: bounded, monotone in doubt, ignores garbage", () => {
    const a = variantAmbiguityOf({ identConfidence: 90 });
    const b = variantAmbiguityOf({ identConfidence: 50, similarShare: 0.8, certainty: "low" });
    assert.ok(a === 0.1 && b > a && b <= 0.8);
    const g = variantAmbiguityOf({ identConfidence: NaN as number, similarShare: Infinity });
    assert.ok(Number.isFinite(g) && g === 0.1);
  });
  it("worked example: five same sold ads at 100 USD give a tight interval around 100; adding a 3x outlier barely moves it", () => {
    const mk = (p: number) => ({ priceUsd: p, kind: "sold" as const, match: "same" as const, tier: "local" as const });
    const base = { category: "electronics", condition: "good", unknownsCount: 0, model: { low: 80, mid: 100, high: 120 }, fallbackLevel: "local" } as never;
    const clean = buildFusedInterval({ ...(base as object), comps: [100, 98, 102, 101, 99].map(mk) } as never);
    const dirty = buildFusedInterval({ ...(base as object), comps: [100, 98, 102, 101, 99, 300].map(mk) } as never);
    assert.ok(Math.abs(Math.log(clean.mid / (100 * 1))) < 0.35);
    assert.ok(Math.abs(Math.log(dirty.mid / clean.mid)) < 0.12, `outlier moved centre ${clean.mid} -> ${dirty.mid}`);
    assert.ok(clean.low < clean.mid && clean.mid < clean.high);
  });
});
