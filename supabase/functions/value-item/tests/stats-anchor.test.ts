import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { median, quantile, weightedMedian, huber } from "../stats.ts";
import { anchorEstimate } from "../anchor.ts";
import { BRAIN_VERSION, MEMORY_MIN_BRAIN_VERSION } from "../config.ts";
import { CONF_CAP_NO_MARKET } from "../interval.config.ts";
import { storableReason } from "../memory.ts";

describe("stats.ts (one copy)", () => {
  it("median, quantile, weightedMedian", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([]), 0);
    assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(weightedMedian([1, 2, 3], [1, 1, 10]), 3);
  });
  it("huber: resists an outlier, scale equivariant in ln space, permutation invariant, deterministic", () => {
    const xs = [4.6, 4.62, 4.58, 4.61, 4.59, 9];
    const h = huber(xs);
    assert.ok(Math.abs(h - 4.6) < 0.15, String(h));
    assert.equal(huber([...xs].reverse()), h);
    assert.equal(huber(xs), h);
    assert.ok(Math.abs(huber(xs.map((x) => x + Math.log(3))) - (h + Math.log(3))) < 1e-9);
    assert.ok(Number.isFinite(huber([5])));
  });
});

describe("anchor.ts (estimate mode)", () => {
  const base = { new_price_usd: 200, new_price_basis: "known_model", category: "electronics", age_class: "mid", condition: "good", rarity: "common" };
  it("computes anchor x depreciation x condition x rarity", () => {
    const r = anchorEstimate(base)!;
    assert.ok(r.mid > 0 && r.mid < 200);
    assert.equal(r.rarity, "common");
  });
  it("rare raises the price, worse condition lowers it, deterministic and scale equivariant", () => {
    assert.ok(anchorEstimate({ ...base, rarity: "rare" })!.mid > anchorEstimate(base)!.mid);
    assert.ok(anchorEstimate({ ...base, condition: "poor" })!.mid < anchorEstimate(base)!.mid);
    assert.ok(Math.abs(anchorEstimate({ ...base, new_price_usd: 400 })!.mid / anchorEstimate(base)!.mid - 2) < 1e-9);
  });
  it("rejects out-of-bounds, non-finite, non-positive and basis none (never guesses)", () => {
    for (const v of [NaN, Infinity, 0, -5, 1e9, null, undefined, 60_000_000]) assert.equal(anchorEstimate({ ...base, new_price_usd: v as number }), null);
    assert.equal(anchorEstimate({ ...base, new_price_basis: "none" }), null);
    assert.equal(anchorEstimate({ ...base, new_price_basis: "garbage" }), null);
  });
});

describe("v5.1 versioning and rails", () => {
  it("version bumped, Memory floor unchanged (resale prices keep their meaning)", () => {
    assert.equal(BRAIN_VERSION, "brain-5.2.0");
    assert.deepEqual([...MEMORY_MIN_BRAIN_VERSION], [5, 1, 0]);
  });
  it("no-market confidence cap lowered", () => assert.ok(CONF_CAP_NO_MARKET <= 40));
  it("estimate runs are never stored", () => {
    const r = storableReason({ key: "k", judgeRan: true, verdict: {} as never, degraded: ["no_market_estimate"], result: { status: "ok" } as never, ident: { confidence: 99 } as never, cfg: { memoryMinIdentConfidence: 50 } as never } as never);
    assert.equal(r, "no_market_estimate");
  });
});
