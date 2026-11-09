import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conformalK, pinball, rng, score, simulate } from "../backtest.ts";

describe("backtest and simulation harness", () => {
  it("is deterministic and bounded", () => {
    const a = score(simulate({ runs: 60, seed: 3 })), b = score(simulate({ runs: 60, seed: 3 }));
    assert.deepEqual(a, b);
    assert.ok(a.n === 60 && a.coverage >= 0 && a.coverage <= 1 && Number.isFinite(a.pinball) && a.medianLnWidth > 0);
    assert.ok(Math.abs(a.coverage + a.below + a.above - 1) < 1e-9);
  });
  it("pinball loss is zero-ish at truth and grows when the interval is wrong", () => {
    assert.ok(pinball(99, 100, 101, 100) < pinball(50, 60, 70, 100));
    assert.ok(rng(1).u() !== rng(2).u());
  });
  it("skips unusable records instead of throwing", () => {
    const s = score([{ truthUsd: -1, stored: { input: { model: { low: 1, mid: 2, high: 3 }, category: "x", condition: "good" }, comps: [] } }, { truthUsd: NaN, stored: {} as never }]);
    assert.equal(s.n, 0); assert.equal(s.skipped, 2);
  });
  it("coverage in a clean synthetic world is not absurd (self-consistency only, NOT evidence about real scans)", () => {
    const s = score(simulate({ runs: 400, seed: 11, adSd: 0.15, sharedBiasSd: 0.08, outlierRate: 0.05 }));
    console.log("SIM coverage", s.coverage.toFixed(3), "below", s.below.toFixed(3), "above", s.above.toFixed(3), "medErr", s.medianAbsLnError.toFixed(3), "width", s.medianLnWidth.toFixed(3));
    assert.ok(s.coverage > 0.6 && s.coverage <= 1);
  });
  it("conformal k needs enough data, and applying it moves coverage toward the target", () => {
    const train = simulate({ runs: 300, seed: 21 }), test = simulate({ runs: 300, seed: 22 });
    assert.equal(conformalK(train.slice(0, 5)), null);
    const k = conformalK(train, 0.8)!;
    assert.ok(k > 0 && Number.isFinite(k));
    const before = score(test), after = score(test, () => ({ k }));
    console.log("conformal k", k.toFixed(3), "coverage", before.coverage.toFixed(3), "->", after.coverage.toFixed(3));
    assert.ok(Math.abs(after.coverage - 0.8) <= Math.abs(before.coverage - 0.8) + 0.03);
  });
});
