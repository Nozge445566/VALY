// T3-c: how many ads the Judge sees depends on its time window.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JUDGE_MAX_ADS, JUDGE_MAX_ADS_SHORT, JUDGE_SHORT_WINDOW_MS, judgeMaxAds } from "../select-ads.ts";

describe("judgeMaxAds", () => {
  it("normal window: all 7; short window: 4; boundary is exclusive", () => {
    assert.equal(judgeMaxAds(JUDGE_SHORT_WINDOW_MS), JUDGE_MAX_ADS);
    assert.equal(judgeMaxAds(JUDGE_SHORT_WINDOW_MS - 1), JUDGE_MAX_ADS_SHORT);
    assert.equal(judgeMaxAds(6000), 7);
    assert.equal(judgeMaxAds(0), 4);
  });
  it("the short cap is smaller than the normal cap", () => assert.ok(JUDGE_MAX_ADS_SHORT < JUDGE_MAX_ADS));
});
