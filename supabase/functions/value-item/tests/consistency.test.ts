import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjudicate, riskUp, higherRisk } from "../consistency.ts";

const f = (id: number, title: string, priceUsd = 100, snippet = "") => ({ id, searchId: "s1", title, snippet, url: `https://x.test/${id}`, site: "x.test", kind: "sold", price: priceUsd, currency: "USD", priceUsd, gl: "se", origin: "SE", tier: "local" }) as never;
const verdict = (ads: unknown[], over: Record<string, unknown> = {}) => ({ identifiable: true, ads, authenticity_risk: "low", ...over }) as never;
const ident = { brand: "Seiko" } as never;

describe("consistency adjudicator (pure, one test per rule)", () => {
  it("R1 replica words force different", () => {
    const r = adjudicate(verdict([{ id: 1, match: "same", condition_vs_ad: "equal" }]), [f(1, "Seiko 5 replica watch")], ident, null);
    assert.equal(r.ads[0].match, "different");
    assert.equal(r.disagreements[0].rule, "replica_words");
    assert.deepEqual(r.contested, [1]);
  });
  it("R2 same without the brand token is demoted one band", () => {
    const r = adjudicate(verdict([{ id: 1, match: "same", condition_vs_ad: "equal" }]), [f(1, "Vintage automatic watch")], ident, null);
    assert.equal(r.ads[0].match, "similar");
  });
  it("R2 does not touch a clean ad", () => {
    const r = adjudicate(verdict([{ id: 1, match: "same", condition_vs_ad: "equal" }]), [f(1, "Seiko 5 SNK809")], ident, null);
    assert.equal(r.ads[0].match, "same");
    assert.equal(r.disagreements.length, 0);
    assert.deepEqual(r.contested, []);
  });
  it("R3 price far from the anchor demotes; skipped without an anchor", () => {
    const ads = [{ id: 1, match: "same", condition_vs_ad: "equal" }];
    assert.equal(adjudicate(verdict(ads), [f(1, "Seiko 5", 500)], ident, null, 100).ads[0].match, "similar");
    assert.equal(adjudicate(verdict(ads), [f(1, "Seiko 5", 20)], ident, null, 100).ads[0].match, "similar");
    assert.equal(adjudicate(verdict(ads), [f(1, "Seiko 5", 500)], ident, null, null).ads[0].match, "same");
    assert.equal(adjudicate(verdict(ads), [f(1, "Seiko 5", 150)], ident, null, 100).ads[0].match, "same");
  });
  it("R4 eye risk higher than the Judge: take the higher and record it", () => {
    const r = adjudicate(verdict([]), [], ident, { signs: [], era: null, risk_hint: "high", search_terms: [] });
    assert.equal(r.risk, "high");
    assert.equal(r.disagreements[0].rule, "eye_risk_higher");
  });
  it("R4 never lowers the Judge's risk", () => {
    const r = adjudicate(verdict([], { authenticity_risk: "high" }), [], ident, { signs: [], era: null, risk_hint: "low", search_terms: [] });
    assert.equal(r.risk, "high");
  });
  it("R5 text mismatch raises risk one notch", () => {
    assert.equal(adjudicate(verdict([], { eye_text_mismatch: ["dial says Seico"] }), [], ident, null).risk, "medium");
    assert.equal(riskUp("medium"), "high");
    assert.equal(riskUp("high"), "high");
    assert.equal(higherRisk("low", "medium"), "medium");
  });
  it("deterministic and does not mutate its input", () => {
    const v = verdict([{ id: 1, match: "same", condition_vs_ad: "equal" }]);
    const a = adjudicate(v, [f(1, "fake Seiko")], ident, null);
    const b = adjudicate(v, [f(1, "fake Seiko")], ident, null);
    assert.deepEqual(a, b);
    assert.equal((v as { ads: { match: string }[] }).ads[0].match, "same");
  });
});

import { buildFusedInterval as buildInterval } from "../fused-interval.ts";
describe("disagreements widen the interval and lower confidence (engine)", () => {
  const base = { model: { low: 80, mid: 100, high: 125 }, modelConfidence: 70, comps: [] as never[], category: "watch", condition: "good", authenticityRisk: "low", unknownsCount: 0 };
  it("more disagreements = wider, never narrower, confidence not higher; zero = unchanged", () => {
    const a = buildInterval({ ...base });
    const b = buildInterval({ ...base, judgeDisagreements: 0 });
    const c = buildInterval({ ...base, judgeDisagreements: 3 });
    assert.deepEqual([a.low, a.high], [b.low, b.high]);
    assert.ok(c.high / c.low > a.high / a.low);
    assert.ok(c.confidenceScore <= a.confidenceScore);
    assert.ok(c.low < c.mid && c.mid < c.high);
  });
});
