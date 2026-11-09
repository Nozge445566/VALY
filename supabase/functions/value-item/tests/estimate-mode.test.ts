import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateIdentification } from "../validate.ts";
import { estimateVerdict } from "../anchor.ts";
import { assemble, needsPhotoResult } from "../pipeline.ts";
import { CONF_CAP_NO_MARKET } from "../interval.config.ts";

const raw = (o: Record<string, unknown> = {}) => ({ identifiable: true, what_is_it: "silver ring", display_name: "Silver ring", category: "jewelry", type: "ring", brand: null, model: null, era: "1970s", confidence: 80, google_queries: ["silver ring sold"], ...o });

describe("Identification anchor facts are validated, never guessed", () => {
  it("accepts bounded facts", () => {
    const v = validateIdentification(raw({ new_price_usd: 120, new_price_basis: "brand_category_typical", material: "silver", rarity: "rare", age_class: "old" }));
    assert.ok(v.ok);
    if (v.ok) { assert.equal(v.value.new_price_usd, 120); assert.equal(v.value.rarity, "rare"); assert.equal(v.value.age_class, "old"); }
  });
  it("bad price, bad basis, bad enums become null", () => {
    for (const bad of [{ new_price_usd: -3, new_price_basis: "known_model" }, { new_price_usd: "abc", new_price_basis: "known_model" }, { new_price_usd: 99, new_price_basis: "none" }, { new_price_usd: 1e9, new_price_basis: "known_model" }]) {
      const v = validateIdentification(raw({ ...bad, rarity: "legendary", age_class: "ancient" }));
      assert.ok(v.ok);
      if (v.ok) { assert.equal(v.value.new_price_usd, null); assert.equal(v.value.rarity, null); assert.equal(v.value.age_class, null); }
    }
  });
  it("old-style answers without the new fields still validate", () => assert.ok(validateIdentification(raw()).ok));
});

describe("estimateVerdict", () => {
  const ident = (o = {}) => { const v = validateIdentification(raw({ new_price_usd: 150, new_price_basis: "known_model", material: "silver", rarity: "rare", age_class: "old", ...o })); assert.ok(v.ok); return v.ok ? v.value : (null as never); };
  it("makes a wide, low-confidence verdict with risk never low", () => {
    const e = estimateVerdict(ident(), null, "en")!;
    assert.ok(e.verdict.price.low < e.verdict.price.mid && e.verdict.price.mid < e.verdict.price.high);
    assert.ok(e.verdict.price.high / e.verdict.price.low > 1.8);
    assert.notEqual(e.verdict.authenticity_risk, "low");
    assert.ok(e.verdict.confidence <= CONF_CAP_NO_MARKET);
  });
  it("no anchor, or unidentifiable = null (caller asks for a photo with the specific message)", () => {
    assert.equal(estimateVerdict(ident({ new_price_usd: null }), null, "en"), null);
    assert.equal(estimateVerdict(null, null, "en"), null);
  });
  it("assemble: no listings -> model_only, capped confidence, rarity widens, price from code", () => {
    const e = estimateVerdict(ident(), null, "en")!;
    const res = assemble({ verdict: e.verdict, ident: ident(), details: null, findings: [], marketState: "none" as never, soldTarget: 5, degraded: ["no_market_estimate"], judgeRan: true, identConfidence: 80, country: "SE", lang: "en" } as never);
    assert.equal(res.status, "ok");
    assert.ok(res.confidenceScore <= CONF_CAP_NO_MARKET, String(res.confidenceScore));
    assert.ok(res.low < res.mid && res.mid < res.high);
    assert.ok(res.degraded.includes("no_market_estimate"));
  });
  it("needs_photo carries the specific message when given", () => {
    assert.match(needsPhotoResult(null, [], "en", "No market data and unclear item.").needsMoreInfo ?? "", /No market data/);
  });
});
