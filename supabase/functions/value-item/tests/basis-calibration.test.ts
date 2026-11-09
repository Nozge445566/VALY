// Calibration by evidence basis: bucket = category|strength|basis, parent chain
// category|strength|basis -> category|strength -> strength -> global.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { basisOf, bucketOf } from "../interval.ts";
import { buildFusedInterval as buildInterval } from "../fused-interval.ts";
import type { IntervalInput, RawComp } from "../interval.ts";
import * as C from "../interval.config.ts";
import { LOCAL_SHARE_FOREIGN_BELOW } from "../market-tiers.ts";
import { lookupK, parentOf } from "../../_shared/calibration.ts";

const sold = (p: number, tier?: "local" | "regional" | "global"): RawComp => ({ priceUsd: p, kind: "sold", tier });

function base(over: Partial<IntervalInput> = {}): IntervalInput {
  return {
    model: { low: 150, mid: 200, high: 260 }, modelConfidence: 70, comps: [], category: "watch",
    condition: "good", authenticityRisk: "low", rarity: "common", unknownsCount: 1, ...over,
  } as IntervalInput;
}

describe("evidence basis in the bucket", () => {
  it("bucketOf: basis last, none is always local, default local", () => {
    assert.equal(bucketOf("Watch", "ok"), "watch|ok|local");
    assert.equal(bucketOf("watch", "ok", "regional"), "watch|ok|regional");
    assert.equal(bucketOf("watch", "none", "global"), "watch|none|local");
  });

  it("bucketOf: optional mode suffix; parent chain falls back to the key without mode (never run yet)", () => {
    assert.equal(bucketOf("watch", "ok", "local", "auction"), "watch|ok|local|auction");
    assert.equal(bucketOf("watch", "ok", "local", undefined), "watch|ok|local");
    assert.equal(parentOf("watch|ok|local|auction"), "watch|ok|local");
    assert.equal(parentOf("watch|ok|local"), "watch|ok");
    assert.equal(lookupK(new Map([["watch|ok|local", 1.3]]), "watch|ok|local|retail"), 1.3);
    assert.equal(lookupK(new Map([["watch|ok|local|retail", 1.1], ["watch|ok|local", 1.3]]), "watch|ok|local|retail"), 1.1);
  });

  it("basisOf: local under the share limit, else the heavier foreign tier", () => {
    assert.equal(basisOf(0, 0, 0), "local");
    assert.equal(basisOf(LOCAL_SHARE_FOREIGN_BELOW - 0.01, 5, 5), "local");
    assert.equal(basisOf(0.5, 3, 1), "regional");
    assert.equal(basisOf(0.5, 1, 3), "global");
    assert.equal(basisOf(0.5, 2, 2), "global", "a tie goes to the noisier tier");
    assert.equal(basisOf(NaN, 1, 1), "local");
  });

  it("the fused engine reports the basis", () => {
    const all = (t: "local" | "regional" | "global") => Array.from({ length: 8 }, (_, i) => sold(195 + i, t));
    assert.equal(buildInterval(base({ comps: all("local") })).breakdown.basis, "local");
    assert.equal(buildInterval(base({ comps: all("regional") })).breakdown.basis, "regional");
    const r = buildInterval(base({ comps: all("global") }));
    assert.match(r.breakdown.bucket, /^watch\|(thin|ok|rich)\|global$/);
    assert.equal(r.breakdown.basis, "global");
    assert.equal(buildInterval(base({ comps: all("local") })).breakdown.basis, "local");
    assert.equal(buildInterval(base({ comps: [] })).breakdown.basis, "local");
  });

  it("one foreign comp among many local ones stays local (below the share limit)", () => {
    const comps = [...Array.from({ length: 12 }, (_, i) => sold(195 + i)), sold(200, "global")];
    assert.equal(buildInterval(base({ comps })).breakdown.basis, "local");
  });
});

describe("bucket parsing", () => {
  it("parent chain", () => {
    assert.equal(parentOf("watch|ok|global"), "watch|ok");
    assert.equal(parentOf("watch|ok"), "ok");
    assert.equal(parentOf("ok"), "global");
    assert.equal(parentOf("global"), null);
  });

  it("lookupK walks the whole chain", () => {
    const t = new Map([["watch|ok", 1.3], ["ok", 1.1], ["global", 1.0]]);
    assert.equal(lookupK(t, "watch|ok|regional"), 1.3);
    assert.equal(lookupK(t, "shoes|ok|regional"), 1.1);
    assert.equal(lookupK(t, "shoes|rich|local"), 1.0);
    t.set("watch|ok|regional", 1.8);
    assert.equal(lookupK(t, "watch|ok|regional"), 1.8);
  });
});
