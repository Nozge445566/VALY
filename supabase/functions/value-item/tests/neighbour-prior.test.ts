import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { neighbourSource, MIN_NEIGHBOURS, NEIGHBOUR_SD_FLOOR, NEIGHBOUR_SD_CAP } from "../neighbour-prior.ts";
import { fuse } from "../fusion.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const row = (mid: number | null, over: object = {}) => ({ midUsd: mid, confidence: 70, createdAt: "2026-10-20T00:00:00Z", brainVersion: "brain-5.1.0", sameModel: true, ...over });

describe("neighbour prior", () => {
  it("needs at least 3 usable rows; old brain versions, low confidence, bad prices and future dates are dropped", () => {
    assert.equal(neighbourSource([row(100), row(110)], NOW), null);
    const junk = [row(null), row(-5), row(NaN), row(100, { brainVersion: "brain-4.2.0" }), row(100, { confidence: 10 }), row(100, { createdAt: "2027-01-01T00:00:00Z" }), row(100, { createdAt: "garbage" })];
    assert.equal(neighbourSource([...junk, row(100), row(105)], NOW), null);
    assert.ok(neighbourSource([...junk, row(100), row(105), row(95)], NOW));
    assert.equal(MIN_NEIGHBOURS, 3);
  });
  it("centre is the weighted median in ln space; sd is never below the floor and never above the cap", () => {
    const s = neighbourSource([row(100), row(100), row(100), row(100)], NOW)!;
    assert.ok(Math.abs(Math.exp(s.mu) - 100) < 1e-6);
    assert.ok(s.sd >= NEIGHBOUR_SD_FLOOR && s.sd <= NEIGHBOUR_SD_CAP);
    const wild = neighbourSource([row(5), row(500), row(5), row(5000), row(20)], NOW)!;
    assert.ok(wild.sd <= NEIGHBOUR_SD_CAP && wild.sd > s.sd);
  });
  it("only-brand neighbours are wider than same-model ones; newer rows weigh more", () => {
    const same = neighbourSource([row(100), row(100), row(100)], NOW)!;
    const brandOnly = neighbourSource([row(100, { sameModel: false }), row(100, { sameModel: false }), row(100, { sameModel: false })], NOW)!;
    assert.ok(brandOnly.sd > same.sd);
    const mixed = neighbourSource([row(50, { createdAt: "2025-12-01T00:00:00Z" }), row(200), row(210), row(205)], NOW)!;
    assert.ok(Math.exp(mixed.mu) > 150);
  });
  it("as a fusion source it is weak: five tight ads still dominate it, and a contradicting prior is tempered", () => {
    const ads = Array.from({ length: 5 }, () => ({ y: Math.log(100), se2: 0.03 }));
    const nb = neighbourSource([row(400), row(420), row(380), row(410)], NOW)!;
    const f = fuse({ ads, sources: [{ name: "neighbours", mu: nb.mu, sd: nb.sd }], variantAmbiguity: 0.1, influenceCap: 0.35, itemVar: 0 } as never)!;
    assert.ok(f.mid > 95 && f.mid < 125, `mid ${f.mid}`);
    assert.ok(f.tempered.length >= 1 || (f.sourceWeights as Record<string, number>)["neighbours"] < 0.3);
  });
});
