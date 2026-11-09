import { test } from "node:test";
import assert from "node:assert/strict";
import { keepRelevant, relevanceOf } from "../relevance.ts";

const ad = (title: string, snippet = "") => ({ title, snippet });

test("an ad about the item scores high, an off-topic page low", () => {
  const q = ["badrumsvåg svart glas såld"];
  assert.ok(relevanceOf(ad("Digital badrumsvåg svart glas 150 kg"), q) >= 0.9);
  assert.ok(relevanceOf(ad("Bästa julklapparna 2026 – 149 kr"), q) < 0.5);
});
test("plurals and compounds count", () => {
  assert.ok(relevanceOf(ad("Badrumsvågar i glas"), ["badrumsvåg glas såld"]) >= 0.5);
});
test("off-topic ads are removed when enough good ones are left", () => {
  const q = ["ikea fullriktig badrumsvåg såld"];
  const ads = [ad("IKEA Fullriktig badrumsvåg"), ad("Fullriktig badrumsvåg IKEA svart"), ad("IKEA badrumsvåg begagnad"), ad("Tvättmaskin Electrolux"), ad("Soffa 3-sits")];
  const r = keepRelevant(ads, q);
  assert.equal(r.kept.length, 3);
  assert.equal(r.removed, 2);
});
test("the filter never empties the list: with too few good ads everything is kept", () => {
  const ads = [ad("Soffa"), ad("Bord"), ad("Stol"), ad("Badrumsvåg")];
  assert.equal(keepRelevant(ads, ["badrumsvåg"]).kept.length, 4);
});
