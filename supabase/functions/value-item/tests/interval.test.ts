import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASKING_TO_SOLD as CHECK_ASKING_TO_SOLD } from "../check.ts";
import * as C from "../interval.config.ts";
import { scoreFromWidth, t90, weightedMedian, weightedQuantile } from "../interval.ts";
import type { IntervalInput, RawComp } from "../interval.ts";
import { localizeResult } from "../localize.ts";
import type { FxTable } from "../fx.ts";
import { assemble, compsForInterval } from "../pipeline.ts";
import type { Finding } from "../types.ts";
import { sampleResult, sampleVerdict } from "./helpers.ts";

const sold = (p: number): RawComp => ({ priceUsd: p, kind: "sold" });
const asking = (p: number): RawComp => ({ priceUsd: p, kind: "asking" });

function base(over: Partial<IntervalInput> = {}): IntervalInput {
  return {
    model: { low: 150, mid: 200, high: 300 },
    modelConfidence: 70,
    comps: [],
    category: "watch",
    condition: "good",
    authenticityRisk: "low",
    unknownsCount: 0,
    rarity: "common",
    ...over,
  };
}

const ratio = (r: { low: number; high: number }) => r.high / r.low;

describe("interval engine: maths helpers", () => {
  it("weighted median and quantile", () => {
    assert.equal(weightedMedian([1, 2, 3], [1, 1, 1]), 2);
    assert.equal(weightedMedian([1, 2, 3, 4], [1, 1, 1, 1]), 2.5);
    assert.equal(weightedQuantile([], [], 0.5), 0);
    // a heavy weight pulls the median
    assert.ok(weightedMedian([1, 10], [9, 1]) < 5);
  });

  it("t90 matches the table and interpolates in 1/df", () => {
    assert.equal(t90(5), 1.476);
    assert.equal(t90(20), 1.325);
    assert.equal(t90(1000), 1.289);
    const mid = t90(7); // between df 6 (1.440) and df 8 (1.397)
    assert.ok(mid < 1.44 && mid > 1.397);
  });

  it("confidence reference values (4H)", () => {
    assert.equal(scoreFromWidth(0.28, false), 87);
    assert.equal(scoreFromWidth(0.5, false), 68);
    assert.equal(scoreFromWidth(1.0, false), 39);
    assert.equal(scoreFromWidth(2.0, false), 13);
    assert.equal(scoreFromWidth(0.2, true), 40, "without a market the score is capped at 40 (v5.1)");
  });

  it("asking-to-sold agrees with check.ts", () => {
    assert.equal(C.ASKING_TO_SOLD, CHECK_ASKING_TO_SOLD);
  });
});

describe("interval engine: wired into the Brain", () => {
  const finding = (id: number, kind: "sold" | "asking", priceUsd: number): Finding => ({
    id, searchId: "s1", title: `Seiko ${id}`, snippet: "", url: `https://x.test/${id}`, site: "x.test", kind,
    price: priceUsd, currency: "USD", priceUsd, gl: "us",
  });

  it("assemble fills the interval fields, the confidence comes from the width", () => {
    const findings = [1, 2, 3, 4, 5].map((i) => finding(i, "sold", 58 + i));
    let breakdown: unknown = null;
    const out = assemble({
      verdict: sampleVerdict({ same: [1, 2, 3, 4, 5] }),
      ident: null,
      details: null,
      findings,
      marketState: "ok",
      soldTarget: 5,
      degraded: [],
      judgeRan: true,
      onInterval: (iv) => { breakdown = iv.breakdown; },
    });
    assert.equal(out.intervalLevel, 0.8);
    assert.ok(Array.isArray(out.widthDrivers));
    assert.ok(out.low < out.mid && out.mid < out.high);
    assert.ok(breakdown && typeof (breakdown as { w: number }).w === "number");
    assert.equal(out.confidenceScore, Math.min(out.confidenceScore, 95));
  });

  it("only the Judge's 'same' and 'similar' findings count, similar ones weigh less", () => {
    const findings = [finding(1, "sold", 60), finding(2, "sold", 61), finding(3, "asking", 70), finding(4, "sold", 500)];
    const verdict = sampleVerdict({ same: [1, 3], similar: [2] });
    const comps = compsForInterval(verdict, findings, true);
    assert.equal(comps.length, 3);
    assert.equal(comps.find((c) => c.priceUsd === 61)!.match, "similar");
    assert.equal(comps.find((c) => c.priceUsd === 60)!.match, "same");
    assert.equal(compsForInterval(verdict, findings, false).length, 4, "without a Judge every priced listing counts");
  });

  it("with no market the Brain's answer is model-only: wide, and never above 70", () => {
    const out = assemble({
      verdict: sampleVerdict({ same: [], similar: [], confidence: 95, price: { low: 100, mid: 200, high: 400 } }),
      ident: null, details: null, findings: [], marketState: "empty", soldTarget: 5, degraded: [], judgeRan: true,
    });
    assert.ok(out.confidenceScore <= 70);
    assert.equal(out.widthDrivers[0], "model_only");
    assert.ok(out.high / out.low > 4);
  });
});
