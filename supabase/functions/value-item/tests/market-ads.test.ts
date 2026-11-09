import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MARKET_ADS_POLICY, applyMarketAds, marketAdsOf, matchOfAd } from "../market-ads.ts";
import type { ResultComparable } from "../types.ts";

const c = (n: number, match?: number): ResultComparable => ({ title: `ad ${n}`, kind: "asking", url: `https://www.tradera.com/item/${n}`, price: 100 + n, ...(match !== undefined ? { match } : {}) });

describe("market-ads.ts", () => {
  it("matchOfAd: bands become shares, the coarse label is the fallback, nothing is invented", () => {
    assert.equal(matchOfAd({ match: "same", p_same: "certain" }), 0.97);
    assert.equal(matchOfAd({ match: "same", p_same: "likely" }), 0.88);
    assert.equal(matchOfAd({ match: "similar", p_same: "unsure" }), 0.6);
    assert.equal(matchOfAd({ match: "same" }), 0.97);
    assert.equal(matchOfAd({ match: "similar" }), 0.6);
    assert.equal(matchOfAd({ match: "different" }), undefined);
    assert.equal(matchOfAd(undefined), undefined);
  });

  it("only ads at or above the bar count, best first, at most three", () => {
    const ads = marketAdsOf([c(1, 0.88), c(2, 0.97), c(3, 0.6), c(4, 0.97), c(5, 0.97)], DEFAULT_MARKET_ADS_POLICY);
    assert.equal(ads.length, 3);
    assert.ok(ads.every((a) => (a.match ?? 0) >= 0.8));
    assert.equal(ads[2].match, 0.97);
  });

  it("fewer than the minimum: no ads at all (the explanation shows instead)", () => {
    assert.deepEqual(marketAdsOf([c(1, 0.97), c(2, 0.6)], DEFAULT_MARKET_ADS_POLICY), []);
    assert.equal(marketAdsOf([c(1, 0.97)], { ...DEFAULT_MARKET_ADS_POLICY, minAds: 1 }).length, 1);
  });

  it("an ad with no match score never qualifies; neither does a bad link or a missing price", () => {
    assert.deepEqual(marketAdsOf([c(1), c(2)], DEFAULT_MARKET_ADS_POLICY), []);
    assert.deepEqual(marketAdsOf([{ ...c(1, 0.97), url: "javascript:x" }, { ...c(2, 0.97), price: 0 }], DEFAULT_MARKET_ADS_POLICY), []);
  });

  it("applyMarketAds keeps the result and adds the decision", () => {
    const r = applyMarketAds({ comparables: [c(1, 0.97), c(2, 0.88)], mid: 5 }, DEFAULT_MARKET_ADS_POLICY);
    assert.equal(r.mid, 5);
    assert.equal(r.marketAds.length, 2);
    assert.equal(r.minAds, 2);
  });
});
