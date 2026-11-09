import { test } from "node:test";
import assert from "node:assert/strict";
import { rewardOf, usableRow, scoreSearchV2 } from "../connector-learn.ts";

const s = (prices: number[], over: object = {}) => ({ weight: 1, kept_sold: 0, discarded: 99, prices, latency_ms: 1000, cancelled: false, failed: false, ...over });

test("consistent prices beat a wild outlier search", () => {
  const good = rewardOf([s([100, 102, 98]), s([101, 99, 100])])!;
  const bad = rewardOf([s([100, 102, 98]), s([500, 480, 520])])!;
  assert.ok(good > bad);
});
test("judge fields (kept_sold/discarded) do not change a v2 reward", () => {
  const a = rewardOf([s([100, 101]), s([99, 100])])!;
  const b = rewardOf([s([100, 101], { kept_sold: 50, discarded: 0 }), s([99, 100], { kept_sold: 50, discarded: 0 })])!;
  assert.equal(a, b);
});
test("no sold prices = 0, a single price in the valuation = unverified 0.4 accuracy", () => {
  assert.equal(scoreSearchV2(s([]), 100), 0);
  const r = rewardOf([s([100]), s([])])!;
  assert.ok(r > 0 && r < 0.4);
});
test("v2 rows are usable without judge_ok, legacy rows are not", () => {
  const base = { mode: "on", applied: true, proposed_changes: 1, bucket: "SE|a|b", judge_ok: false, reward: null };
  const q = { rule: "R1", original_query: "a", executed_query: "a", is_haiku: false, kept_sold: 0, discarded: 0, cancelled: false, failed: false };
  assert.equal(usableRow({ ...base, searches: [{ ...q, prices: [1, 2] }] }), true);
  assert.equal(usableRow({ ...base, searches: [q] }), false);
});
