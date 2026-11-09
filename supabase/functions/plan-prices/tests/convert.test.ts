import { test } from "node:test";
import assert from "node:assert/strict";
import { convertPlanAmounts, parsePlanPriceRequest } from "../convert.ts";

const rates = { USD: 1, SEK: 10, EUR: 0.9, JPY: 150 };

test("converts SEK amounts with the given rates and rounds to the currency's decimals", () => {
  assert.deepEqual(convertPlanAmounts([0, 100, 99], "USD", rates), [0, 10, 9.9]);
  assert.deepEqual(convertPlanAmounts([100, 99], "JPY", rates), [1500, 1485]);
  assert.deepEqual(convertPlanAmounts([100], "SEK", rates), [100]);
});

test("a missing rate gives null, never a made-up price", () => {
  assert.equal(convertPlanAmounts([100], "CHF", rates), null);
});

test("request validation", () => {
  assert.deepEqual(parsePlanPriceRequest({ currency: "usd", amounts: [0, 99] }), { currency: "USD", amounts: [0, 99] });
  assert.equal(parsePlanPriceRequest(null), null);
  assert.equal(parsePlanPriceRequest({ currency: "XXX", amounts: [1] }), null);
  assert.equal(parsePlanPriceRequest({ currency: "USD", amounts: [] }), null);
  assert.equal(parsePlanPriceRequest({ currency: "USD", amounts: [-1] }), null);
  assert.equal(parsePlanPriceRequest({ currency: "USD", amounts: ["9"] }), null);
  assert.equal(parsePlanPriceRequest({ currency: "USD", amounts: new Array(13).fill(1) }), null);
});
