import test from "node:test";
import assert from "node:assert/strict";
import { PLANS, yearlySavingPct } from "../plans.ts";

test("plan limits match the pricing sheet", () => {
  const by = Object.fromEntries(PLANS.map((p) => [p.id, p]));
  assert.deepEqual([by.free.scansPerMonth, by.pro.scansPerMonth, by.premium.scansPerMonth, by.business.scansPerMonth], [20, 300, 1000, 5000]);
  assert.deepEqual([by.free.scansPerDay, by.pro.scansPerDay, by.premium.scansPerDay, by.business.scansPerDay], [null, null, null, null]);
  assert.deepEqual([by.pro.priceMonth, by.premium.priceMonth, by.business.priceMonth], [99, 199, 749]);
});

test("yearly price is 12 x monthly (no discount), zero for free", () => {
  assert.equal(yearlySavingPct(PLANS[0]), 0);
  assert.equal(yearlySavingPct(PLANS[1]), 0);
  assert.equal(yearlySavingPct(PLANS[2]), 0);
});
