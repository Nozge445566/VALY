// "Matte och kontroll": the Judge labels, code makes every number. These tests protect the six steps.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONDITION_FACTOR, priceFromLabels } from "../math.ts";
import { validateAuthenticityReport, validateJudgeLabels } from "../validate.ts";
import { withEyeSearch } from "../pipeline.ts";
import type { AdLabel, Finding, JudgeVerdict, SearchPlan } from "../types.ts";

const fin = (id: number, priceUsd: number, kind: "sold" | "asking" = "sold"): Finding => ({
  id, searchId: "s1", title: `Item ${id}`, snippet: "", url: `https://x.test/${id}`, site: "x.test", kind,
  price: priceUsd, currency: "USD", priceUsd, gl: "se", origin: "SE", tier: "local",
});
const verdict = (ads: AdLabel[], risk: JudgeVerdict["authenticity_risk"] = "low"): JudgeVerdict => ({
  identifiable: true, display_name: "x", category: "watch", brand: null, model: null,
  condition: { grade: "good", details: "" }, same: [], similar: [], ads, price: { low: 0.01, mid: 0.01, high: 0.01 },
  confidence: 0, authenticity_risk: risk, authenticity_note: "", unknowns: [], extra_photo_request: null, reason: "", missing: [],
});
const same = (id: number, c: AdLabel["condition_vs_ad"] = "equal"): AdLabel => ({ id, match: "same", condition_vs_ad: c });

describe("priceFromLabels", () => {
  it("step 1: ads that are not the same item are thrown away", () => {
    const r = priceFromLabels(verdict([same(1), same(2), same(3), { id: 4, match: "different", condition_vs_ad: "equal" }]), [fin(1, 100), fin(2, 100), fin(3, 100), fin(4, 5000)])!;
    assert.deepEqual(r.verdict.same, [1, 2, 3]);
    assert.equal(r.notes.droppedNotSame, 1);
    assert.ok(Math.abs(r.verdict.price.mid - 100) < 0.01);
  });
  it("step 2: a statistical outlier is removed", () => {
    const f = [fin(1, 100), fin(2, 104), fin(3, 98), fin(4, 102), fin(5, 99), fin(6, 1000)];
    const r = priceFromLabels(verdict(f.map((x) => same(x.id))), f)!;
    assert.equal(r.notes.droppedOutliers, 1);
    assert.ok(!r.verdict.same.includes(6));
  });
  it("step 3: condition label becomes a FIXED percentage", () => {
    const f = [fin(1, 100), fin(2, 100), fin(3, 100)];
    const worse = priceFromLabels(verdict(f.map((x) => same(x.id, "worse"))), f)!;
    const better = priceFromLabels(verdict(f.map((x) => same(x.id, "better"))), f)!;
    assert.ok(Math.abs(worse.verdict.price.mid - 100 * CONDITION_FACTOR.worse) < 0.01);
    assert.ok(Math.abs(better.verdict.price.mid - 100 * CONDITION_FACTOR.better) < 0.01);
    assert.equal(worse.adjusted.get(1), 100 * CONDITION_FACTOR.worse);
  });
  it("step 4: range is ordered low < mid < high, never a point", () => {
    const r = priceFromLabels(verdict([same(1)]), [fin(1, 50)])!;
    assert.ok(r.verdict.price.low < r.verdict.price.mid && r.verdict.price.mid < r.verdict.price.high);
  });
  it("step 5: more agreeing ads give more confidence than few or spread ones", () => {
    const many = [1, 2, 3, 4, 5].map((i) => fin(i, 100 + i));
    const few = [fin(1, 100)];
    const spread = [fin(1, 50), fin(2, 100), fin(3, 200)];
    const c = (f: Finding[]) => priceFromLabels(verdict(f.map((x) => same(x.id))), f)!.verdict.confidence;
    assert.ok(c(many) > c(few));
    assert.ok(c(many) > c(spread));
  });
  it("step 6: high risk gives a wider range and lower confidence", () => {
    const f = [1, 2, 3, 4, 5].map((i) => fin(i, 100 + i));
    const ads = f.map((x) => same(x.id));
    const lo = priceFromLabels(verdict(ads, "low"), f)!.verdict;
    const hi = priceFromLabels(verdict(ads, "high"), f)!.verdict;
    assert.ok(hi.price.high - hi.price.low > lo.price.high - lo.price.low);
    assert.ok(hi.confidence < lo.confidence);
  });
  it("no same or similar ad: returns null (no price is invented)", () => {
    assert.equal(priceFromLabels(verdict([{ id: 1, match: "different", condition_vs_ad: "equal" }]), [fin(1, 100)]), null);
    assert.equal(priceFromLabels(verdict([]), []), null);
  });
  it("similar-only is used as a last resort and capped at confidence 45", () => {
    const f = [1, 2, 3, 4, 5].map((i) => fin(i, 100));
    const r = priceFromLabels(verdict(f.map((x) => ({ id: x.id, match: "similar" as const, condition_vs_ad: "equal" as const }))), f)!;
    assert.equal(r.notes.usedSimilarFallback, true);
    assert.ok(r.verdict.confidence <= 45);
  });
});

describe("validateJudgeLabels", () => {
  const base = { identifiable: true, authenticity_risk: "low", condition: { grade: "good", details: "" }, brand: null, model: null, category: "watch", display_name: "w" };
  it("reads labels, ignores any price or confidence the Judge wrote", () => {
    const v = validateJudgeLabels({ ...base, price: { low: 1, mid: 2, high: 3 }, confidence: 99, ads: [{ id: 1, match: "same", condition_vs_ad: "worse" }, { id: 2, match: "similar" }] }, 2);
    assert.ok(v.ok);
    if (v.ok) {
      assert.deepEqual(v.value.same, [1]);
      assert.deepEqual(v.value.similar, [2]);
      assert.equal(v.value.confidence, 0);
      assert.equal(v.value.price.mid, 0.01);
    }
  });
  it("drops unreadable labels and out-of-range ids instead of guessing", () => {
    const v = validateJudgeLabels({ ...base, ads: [{ id: 1, match: "maybe" }, { id: 99, match: "same" }, { id: 2, match: "same" }] }, 2);
    assert.ok(v.ok && v.value.ads!.length === 1 && v.value.ads![0].id === 2);
  });
  it("a finished answer must label the ads", () => {
    assert.equal(validateJudgeLabels({ ...base, ads: [] }, 3).ok, false);
  });
});

describe("Authenticity eye and eye search", () => {
  it("validateAuthenticityReport tolerates a sparse answer", () => {
    const v = validateAuthenticityReport({ signs: [{ kind: "weird", text: "Replaced clasp, newer metal" }], era: "unknown", risk_hint: "weird" });
    assert.ok(v.ok && v.value.era === null && v.value.risk_hint === "unknown" && v.value.signs.length === 1 && v.value.signs[0].kind === "other");
  });
  const plan = (n: number): SearchPlan => ({
    strategyVersion: null, source: "fixed",
    searches: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, query: `seiko snk809 sold ${i}`, template_id: "t", kind: "fixed" as const, gl: "se", hl: "sv" })),
  } as SearchPlan);
  it("ALWAYS adds the eye search as a fifth, extra search (v5.1), even on a full 4-search plan", () => {
    for (const n of [1, 2, 4]) {
      const out = withEyeSearch(plan(n), null, { signs: [], era: "1970s", risk_hint: "low", search_terms: ["limited"] });
      assert.equal(out.searches.length, n, "planned searches untouched");
      assert.equal(out.extraSearches?.length, 1);
      assert.match(out.extraSearches![0].query, /limited/);
      assert.equal(out.extraSearches![0].template_id, "eyes_evidence");
      assert.equal(out.extraSearches![0].kind, "fixed");
      assert.equal(out.extraSearches![0].gl, "se");
    }
  });
  it("buys NO duplicate search when the eyes read nothing new, and never above 7 in total", () => {
    const out = withEyeSearch(plan(4), null, null);
    assert.equal(out.extraSearches, undefined, "same query as the base search would add no ads and cost a search");
    assert.equal(withEyeSearch(plan(0), null, null).extraSearches, undefined);
    assert.ok(out.searches.length + (out.extraSearches?.length ?? 0) <= 7);
  });
});

import { buildFactors as _buildFactors } from "../present.ts";
it("buildFactors shows Authenticity eye construction signs/era and text mismatch", () => {
  const v = { display_name: "Watch", brand: null, model: null, condition: { grade: "good", details: "" }, same: [], reason: "", unknowns: [], eye_text_mismatch: ["Eyes read 'Omega' but photo shows 'Omeda'"] } as never;
  const f = _buildFactors({ verdict: v, details: null, findings: [], marketState: "empty", soldTarget: 3, needsMoreInfo: null, lang: "en",
    authenticity: { signs: [{ kind: "construction", text: "Hand-finished seams" }], era: "1970s", risk_hint: "low", search_terms: [] } });
  assert.ok(f.some((x) => x.label === "Construction and era" && x.detail.includes("Hand-finished seams") && x.detail.includes("1970s")));
  assert.ok(f.some((x) => x.label === "Text check" && x.detail.includes("Omeda")));
});
