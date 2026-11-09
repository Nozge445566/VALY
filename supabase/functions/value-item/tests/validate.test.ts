import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateDetailReport, validateIdentification, validateJudge, validateSearchPlan } from "../validate.ts";

const goodPlan = () => ({
  ok: true,
  strategy_version: 7,
  searches: [
    { id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" },
    { id: "s2", query: "seiko snk809 såld", template_id: "fx_local_sold", kind: "exploit", gl: "se", hl: "sv" },
    { id: "s3", query: "seiko snk809 site:chrono24.com", template_id: "fx_specialist", kind: "exploit", gl: "us", hl: "en" },
    { id: "s4", query: "seiko snk809 slutpris tradera", template_id: "mut:site:tradera.com", kind: "experiment", gl: "se", hl: "sv" },
  ],
  stop: { sold_prices: 5, max_ms: 2000 },
});

describe("validateSearchPlan (the gate the Search AI answer must pass)", () => {
  it("accepts a good plan", () => {
    const v = validateSearchPlan(goodPlan());
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.value.searches.length, 4);
      assert.equal(v.value.strategyVersion, 7);
      assert.equal(v.value.source, "search_ai");
    }
  });

  it("rejects more than four searches", () => {
    const p = goodPlan();
    p.searches.push({ id: "s1", query: "extra search", template_id: "x", kind: "exploit", gl: "us", hl: "en" });
    assert.equal(validateSearchPlan(p).ok, false);
  });

  it("accepts all searches as experiments (all four learn)", () => {
    const p = goodPlan();
    for (const x of p.searches) x.kind = "experiment";
    assert.equal(validateSearchPlan(p).ok, true);
  });

  it("rejects a stop beyond the hard caps", () => {
    const a = goodPlan();
    a.stop.max_ms = 5000;
    assert.equal(validateSearchPlan(a).ok, false);
    const b = goodPlan();
    b.stop.sold_prices = 9;
    assert.equal(validateSearchPlan(b).ok, false);
  });

  it("rejects bad queries, bad countries, and plans that are not ok", () => {
    const a = goodPlan();
    a.searches[1].query = "x";
    assert.equal(validateSearchPlan(a).ok, false);
    const b = goodPlan();
    b.searches[2].gl = "sweden";
    assert.equal(validateSearchPlan(b).ok, false);
    assert.equal(validateSearchPlan({ ok: false, reason: "no_data" }).ok, false);
    assert.equal(validateSearchPlan("nope").ok, false);
  });

  it("never lets prices through: unknown fields are ignored", () => {
    const p = { ...goodPlan(), price: { low: 1, mid: 2, high: 3 } };
    const v = validateSearchPlan(p);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal("price" in v.value, false);
  });
});

describe("validateIdentification", () => {
  const base = {
    identifiable: true, what_is_it: "A watch", display_name: "Seiko 5", category: "watch", type: "automatic watch",
    brand: "Seiko", model: "SNK809", era: "2010s", origin_country: "jp", confidence: 85,
    google_queries: ["seiko snk809 sold ebay", "x"],
  };
  it("accepts a good answer and tidies it", () => {
    const v = validateIdentification(base);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.equal(v.value.origin_country, "JP");
      assert.deepEqual(v.value.google_queries, ["seiko snk809 sold ebay"]);
    }
  });
  it("needs at least one query for an identifiable item", () => {
    assert.equal(validateIdentification({ ...base, google_queries: [] }).ok, false);
  });
  it("accepts 'not identifiable' without the rest", () => {
    const v = validateIdentification({ identifiable: false, what_is_it: "", display_name: "", category: "", type: "", confidence: 0, google_queries: [] });
    assert.equal(v.ok, true);
  });
});

describe("validateDetailReport", () => {
  it("accepts a report and turns unknown kinds into 'other'", () => {
    const v = validateDetailReport({
      details: [{ kind: "weird", text: "A stamp reading 925" }, { kind: "logo", text: "" }],
      condition: { grade: "fair", details: "scratches" },
      authenticity_signals: ["hallmark looks right"],
    });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.value.details, [{ kind: "other", text: "A stamp reading 925" }]);
  });
  it("needs a condition", () => {
    assert.equal(validateDetailReport({ details: [] }).ok, false);
  });
});

describe("validateJudge", () => {
  const base = {
    identifiable: true, display_name: "Seiko 5", category: "watch", brand: "Seiko", model: "SNK809",
    condition: { grade: "good", details: "ok" }, same: [1, 2, 9, 2], similar: [2, 3],
    price: { low: 80, mid: 60, high: 45 }, confidence: 70, authenticity_risk: "low", reason: "ok",
  };
  it("keeps only real finding numbers, once, and 'same' wins over 'similar'", () => {
    const v = validateJudge(base, 4);
    assert.equal(v.ok, true);
    if (v.ok) {
      assert.deepEqual(v.value.same, [1, 2]);
      assert.deepEqual(v.value.similar, [3]);
    }
  });
  it("puts a mixed-up price range in order", () => {
    const v = validateJudge(base, 4);
    if (v.ok) assert.deepEqual(v.value.price, { low: 45, mid: 60, high: 80 });
  });
  it("lifts a zero price to the smallest real price instead of failing the answer", () => {
    const v = validateJudge({ ...base, price: { low: 0, mid: 0.4, high: 1 } }, 4);
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.value.price, { low: 0.01, mid: 0.4, high: 1 });
  });
});
