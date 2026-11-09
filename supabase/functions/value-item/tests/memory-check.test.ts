import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticityFlagOf, checkFigures, checkResult, confidenceCap, EMPTY_EVIDENCE } from "../check.ts";
import { buildFingerprint, canLookInMemory, isUsableHit, memoryKey } from "../memory.ts";
import { localizeResult } from "../localize.ts";
import { FALLBACK_RATES } from "../fx.ts";
import { SAMPLE_IDENT, sampleResult, storedValuation, testConfig } from "./helpers.ts";

describe("Memory", () => {
  it("builds a fingerprint with the user's market and language", () => {
    const fp = buildFingerprint(SAMPLE_IDENT, "se");
    assert.equal(fp.country, "SE");
    assert.equal(fp.language, "sv");
    assert.equal(fp.brand, "seiko");
    assert.equal(buildFingerprint(SAMPLE_IDENT, null).country, "ZZ");
  });

  it("only recognises specific items (brand AND model), per country", () => {
    const fp = buildFingerprint(SAMPLE_IDENT, "SE");
    assert.equal(memoryKey(fp), "m1|seiko|snk809|SE");
    assert.notEqual(memoryKey(fp), memoryKey({ ...fp, country: "DE" }));
    assert.equal(memoryKey({ ...fp, model: null }), null);
    assert.equal(memoryKey({ ...fp, brand: null }), null);
  });

  it("ignores word order and accents in the model", () => {
    const a = buildFingerprint({ ...SAMPLE_IDENT, model: "Air Max 90" }, "US");
    const b = buildFingerprint({ ...SAMPLE_IDENT, model: "90 air  MAX" }, "US");
    assert.equal(memoryKey(a), memoryKey(b));
  });

  it("trusts a stored valuation only when it is recent, confident and eligible", () => {
    const cfg = testConfig();
    const now = Date.now();
    const base = storedValuation({ createdAt: new Date(now - 5 * 86400000).toISOString() });
    assert.equal(isUsableHit(base, cfg, now, "SE"), true);
    assert.equal(isUsableHit({ ...base, memoryEligible: false }, cfg, now, "SE"), false);
    assert.equal(isUsableHit({ ...base, createdAt: new Date(now - 40 * 86400000).toISOString() }, cfg, now, "SE"), false);
    assert.equal(isUsableHit(storedValuation({ createdAt: base.createdAt }, { confidenceScore: 40 }), cfg, now, "SE"), false);
    assert.equal(isUsableHit(storedValuation({ createdAt: base.createdAt }, { status: "needs_photo" }), cfg, now, "SE"), false);
  });

  it("only looks in Memory when Identification is sure enough", () => {
    const cfg = testConfig();
    assert.equal(canLookInMemory(SAMPLE_IDENT, cfg), true);
    assert.equal(canLookInMemory({ ...SAMPLE_IDENT, confidence: 30 }, cfg), false);
  });
});

describe("Check (code)", () => {
  it("puts figures in order and widens a falsely precise range", () => {
    const r = checkFigures({ low: 100, mid: 100, high: 101 }, EMPTY_EVIDENCE);
    assert.ok(r.range.low < 100 && r.range.high > 101);
  });

  it("pulls an estimate that disagrees with three or more sold prices back towards them", () => {
    const ev = { ...EMPTY_EVIDENCE, judgeRan: true, keptSoldUsd: [190, 200, 210, 205] };
    const r = checkFigures({ low: 30, mid: 50, high: 80 }, ev);
    assert.ok(r.range.mid > 100, `mid ${r.range.mid}`);
    assert.ok(r.adjusted);
  });

  it("leaves a good estimate alone", () => {
    const ev = { ...EMPTY_EVIDENCE, judgeRan: true, keptSoldUsd: [55, 60, 62, 58, 65] };
    const r = checkFigures({ low: 45, mid: 60, high: 80 }, ev);
    assert.equal(r.adjusted, null);
    assert.equal(r.range.mid, 60);
  });

  it("flags authenticity from the Judge and from replica words", () => {
    assert.equal(authenticityFlagOf("high", []), "high");
    assert.equal(authenticityFlagOf("medium", []), "check");
    assert.equal(authenticityFlagOf("low", ["Rolex Submariner replica AAA"]), "check");
    assert.equal(authenticityFlagOf("low", ["Seiko 5"]), "none");
  });

  it("caps confidence by real evidence (fewer than 5 sold prices lowers it)", () => {
    const ev = (n: number) => ({ ...EMPTY_EVIDENCE, judgeRan: true, keptSoldUsd: Array(n).fill(60) });
    assert.equal(confidenceCap(ev(5), "none", false), 95);
    assert.equal(confidenceCap(ev(3), "none", false), 78);
    assert.equal(confidenceCap(ev(1), "none", false), 65);
    assert.equal(confidenceCap(ev(0), "none", false), 50);
    assert.equal(confidenceCap({ ...EMPTY_EVIDENCE }, "none", false), 35);
    assert.equal(confidenceCap(ev(5), "high", false), 55);
    assert.equal(confidenceCap(ev(5), "none", true), 40);
  });

  it("checkResult lowers a too-confident result and adds the authenticity factor", () => {
    const ev = { ...EMPTY_EVIDENCE, judgeRan: true, keptSoldUsd: [60] };
    const r = checkResult(sampleResult({ confidenceScore: 92 }), ev, "high");
    assert.equal(r.confidenceScore, 55);
    assert.equal(r.confidence, "medium");
    assert.equal(r.authenticityFlag, "high");
    assert.ok(r.factors.some((f) => f.label === "Authenticity"));
  });
});

describe("Exchange rates", () => {
  it("converts the finished USD answer to the user's currency", () => {
    const fx = { rates: FALLBACK_RATES, asOf: null, source: "live" as const };
    const r = localizeResult(sampleResult({ low: 100, mid: 200, high: 300 }), fx, "SEK");
    assert.equal(r.currency, "SEK");
    assert.ok(Math.abs(r.mid - 200 * FALLBACK_RATES.SEK) < 10);
  });
});
