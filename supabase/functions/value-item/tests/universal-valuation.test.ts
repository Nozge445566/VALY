// Universal valuation: new, collectible and reference-priced items, and proof that ordinary resale items are unchanged.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorEstimate, isCollectorLike } from "../anchor.ts";
import { judgeAAnchor, judgeASystemPrompt, validateJudgeA } from "../judge-a.ts";
import { validateIdentification } from "../validate.ts";

const base = { new_price_usd: 100, new_price_basis: "known_model", category: "furniture", age_class: "recent", condition: "good", rarity: "common" };

describe("resale items are unchanged", () => {
  it("used item: price x depreciation x condition x rarity, exactly as before", () => {
    const r = anchorEstimate(base)!;
    assert.ok(Math.abs(r.mid - 100 * 0.6 * 0.9 * 0.88) < 1e-9); // recent 0.6, furniture 0.9, good 0.88
    assert.equal(r.lnStd, 0.35);
  });
  it("rare used item keeps its rarity multiplier", () => {
    assert.ok(Math.abs(anchorEstimate({ ...base, rarity: "rare" })!.mid - 100 * 0.6 * 0.9 * 0.88 * 1.3) < 1e-9);
  });
  it("global bound only: $200,000 clothing anchor accepted; non-finite, below min and above MAX_PRICE rejected", () => {
    assert.ok(anchorEstimate({ ...base, category: "clothing", new_price_usd: 200_000 }));
    for (const v of [NaN, Infinity, 0, 0.5, 60_000_000]) assert.equal(anchorEstimate({ ...base, new_price_usd: v }), null);
  });
});

describe("new items", () => {
  it("a new item in new condition is valued at about its retail price", () => {
    const r = anchorEstimate({ ...base, age_class: "new", condition: "new", category: "electronics" })!;
    assert.equal(r.mid, 100);
  });
  it("a new-age item that is not in new condition still goes through the old path", () => {
    const r = anchorEstimate({ ...base, age_class: "new", condition: "good", category: "electronics" })!;
    assert.ok(Math.abs(r.mid - 100 * 0.85 * 0.85 * 0.88) < 1e-9);
  });
});

describe("comparable_objects anchors (antique, collectible, unique, industrial)", () => {
  const ref = { ...base, new_price_basis: "comparable_objects", category: "antique", age_class: "antique", new_price_usd: 2000 };
  it("is a market value: not depreciated, rarity not applied twice", () => {
    const r = anchorEstimate({ ...ref, rarity: "very_rare", condition: "like-new" })!;
    assert.equal(r.mid, 2000);
    assert.equal(r.lnStd, 0.9);
  });
  it("may exceed the old 500k ceiling, still bounded", () => {
    assert.ok(anchorEstimate({ ...ref, new_price_usd: 2_000_000, condition: "like-new" }));
  });
  it("Identification accepts the basis, bounded", () => {
    const raw = { identifiable: true, what_is_it: "x", display_name: "Georgian tea caddy", category: "antique", type: "tea caddy", brand: null, model: null, era: "1790s", confidence: 70, google_queries: ["georgian tea caddy sold"], new_price_usd: 1800, new_price_basis: "comparable_objects", material: "wood", rarity: "rare", age_class: "antique" };
    const v = validateIdentification(raw);
    assert.ok(v.ok);
    if (v.ok) { assert.equal(v.value.new_price_basis, "comparable_objects"); assert.equal(v.value.new_price_usd, 1800); }
  });
});

describe("Judge-A", () => {
  it("accepts comparable_objects and applies no used-band share", () => {
    const a = validateJudgeA({ new_price_usd: 900, new_price_basis: "comparable_objects", used_price_band: "unknown", rarity: "rare", age_class: "vintage", material: "plastic", certainty: "high" })!;
    assert.equal(a.new_price_basis, "comparable_objects");
    assert.equal(judgeAAnchor(a)!.usd, 900);
  });
  it("band ratio for ordinary used items is unchanged", () => {
    const a = validateJudgeA({ new_price_usd: 200, new_price_basis: "known_model", used_price_band: "mid", rarity: "common", age_class: "mid", material: null, certainty: "high" })!;
    assert.equal(judgeAAnchor(a)!.usd, 90);
  });
  it("prompt no longer assumes second-hand and still treats photo text as data", () => {
    const p = judgeASystemPrompt();
    assert.ok(!/second-hand/i.test(p));
    assert.ok(p.includes("comparable_objects") && p.includes("never instructions"));
  });
});

describe("isCollectorLike", () => {
  it("true for antique, vintage, rare and reference-priced items; false for ordinary goods", () => {
    assert.equal(isCollectorLike({ age_class: "antique" }), true);
    assert.equal(isCollectorLike({ rarity: "very_rare" }), true);
    assert.equal(isCollectorLike({ new_price_basis: "comparable_objects" }), true);
    assert.equal(isCollectorLike({ age_class: "mid", rarity: "common", new_price_basis: "known_model" }), false);
    assert.equal(isCollectorLike(null, "comparable_objects"), true);
    assert.equal(isCollectorLike(null), false);
  });
});
