import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuse, capInfluence } from "../fusion.ts";
import { validateJudgeA, judgeAAnchor, judgeASystemPrompt } from "../judge-a.ts";

const ads = (ys: number[], se2 = 0.02) => ys.map((y) => ({ y, se2 }));

describe("fusion.ts", () => {
  it("returns null with no evidence and never NaN with some", () => {
    assert.equal(fuse({ ads: [] }), null);
    const r = fuse({ ads: ads([Math.log(100)]) })!;
    for (const v of [r.mu, r.sd, r.df, r.low, r.mid, r.high]) assert.ok(Number.isFinite(v));
    assert.ok(r.low < r.mid && r.mid < r.high);
  });
  it("is deterministic and permutation invariant", () => {
    const ys = [4.6, 4.7, 4.65, 4.9, 4.55].map((x) => x);
    const a = fuse({ ads: ads(ys) })!, b = fuse({ ads: ads([...ys].reverse()) })!;
    assert.ok(Math.abs(a.mid - b.mid) < 1e-6);
    assert.deepEqual(fuse({ ads: ads(ys) }), a);
  });
  it("influence sums to 1 and no ad exceeds the cap (>=3 ads)", () => {
    const r = fuse({ ads: [{ y: 4.6, se2: 0.0001 }, { y: 4.7, se2: 0.5 }, { y: 4.65, se2: 0.5 }, { y: 4.6, se2: 0.5 }] })!;
    assert.ok(Math.abs(r.influence.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(Math.max(...r.influence) <= 0.35 + 1e-6, String(Math.max(...r.influence)));
  });
  it("an outlier ad barely moves the price and spread widens (tau2) when ads disagree", () => {
    const tight = fuse({ ads: ads([4.6, 4.61, 4.59, 4.6, 4.62]) })!;
    const out = fuse({ ads: ads([4.6, 4.61, 4.59, 4.6, 6.5]) })!;
    assert.ok(Math.abs(out.mu - tight.mu) < 0.2, String(out.mu - tight.mu));
    const wide = fuse({ ads: ads([4.0, 5.2, 4.6, 5.0, 4.2]) })!;
    assert.ok(wide.tau2 > tight.tau2);
    assert.ok(wide.high / wide.low > tight.high / tight.low);
  });
  it("more agreeing ads narrow the interval, but shared variant ambiguity puts a floor under it", () => {
    const few = fuse({ ads: ads([4.6, 4.6, 4.6]) })!, many = fuse({ ads: ads(Array(30).fill(4.6)) })!;
    assert.ok(many.sd < few.sd);
    const amb = fuse({ ads: ads(Array(300).fill(4.6)), variantAmbiguity: 1 })!;
    assert.ok(amb.sd > 0.15, String(amb.sd));
  });
  it("fuses an independent source by precision and tempers a source that contradicts the ads", () => {
    const base = fuse({ ads: ads([4.6, 4.6, 4.6]) })!;
    const agree = fuse({ ads: ads([4.6, 4.6, 4.6]), sources: [{ name: "anchor", mu: 4.62, sd: 0.4 }] })!;
    assert.ok(Math.abs(agree.mu - base.mu) < 0.05);
    assert.deepEqual(agree.tempered, []);
    const far = fuse({ ads: ads([4.6, 4.6, 4.6]), sources: [{ name: "anchor", mu: 7.5, sd: 0.3 }] })!;
    assert.deepEqual(far.tempered, ["anchor"]);
    assert.ok(far.sourceWeights.anchor < 0.2, String(far.sourceWeights.anchor));
    assert.ok(far.sd > base.sd);
  });
  it("works with sources only (no market) and ignores non-finite input", () => {
    const r = fuse({ ads: [{ y: NaN, se2: 0.1 }], sources: [{ name: "anchor", mu: 4.6, sd: 0.5 }, { name: "bad", mu: NaN, sd: 1 }] })!;
    assert.ok(Math.abs(r.mid - Math.exp(4.6)) < 1e-6);
    assert.equal(r.adsWeight, 0);
  });
  it("capInfluence keeps the total and respects the cap", () => {
    const o = capInfluence([10, 1, 1, 1], 0.4);
    assert.ok(Math.abs(o.reduce((a, b) => a + b, 0) - 13) < 1e-9);
    assert.ok(Math.max(...o) / 13 <= 0.4 + 1e-9);
  });
});

describe("judge-a.ts", () => {
  it("prompt treats photo text as data and asks for JSON only", () => {
    const p = judgeASystemPrompt();
    assert.match(p, /never instructions/);
    assert.match(p, /JSON/);
  });
  it("validates bounded labelled facts; bad fields become null, never guessed", () => {
    const ok = validateJudgeA({ new_price_usd: 300, new_price_basis: "known_model", used_price_band: "mid", rarity: "rare", age_class: "mid", material: "steel", certainty: "high" })!;
    assert.equal(ok.new_price_usd, 300);
    const bad = validateJudgeA({ new_price_usd: 9e9, new_price_basis: "known_model", used_price_band: "wild", rarity: "mythic", age_class: "x", certainty: 5 })!;
    assert.equal(bad.new_price_usd, null);
    assert.equal(bad.new_price_basis, "none");
    assert.equal(bad.used_price_band, "unknown");
    assert.equal(bad.rarity, null);
    assert.equal(bad.certainty, "low");
    assert.equal(validateJudgeA("text"), null);
    assert.equal(validateJudgeA({ new_price_usd: 60_000_000, new_price_basis: "known_model" })!.new_price_usd, null); // above MAX_PRICE
  });
  it("anchor: band x new price, wider when certainty is low, null without basis", () => {
    const hi = judgeAAnchor(validateJudgeA({ new_price_usd: 200, new_price_basis: "known_model", used_price_band: "mid", certainty: "high" })!)!;
    const lo = judgeAAnchor(validateJudgeA({ new_price_usd: 200, new_price_basis: "known_model", used_price_band: "mid", certainty: "low" })!)!;
    assert.ok(Math.abs(hi.usd - 90) < 1e-9);
    assert.ok(lo.lnStd > hi.lnStd);
    assert.equal(judgeAAnchor(validateJudgeA({ new_price_usd: 200, new_price_basis: "none", used_price_band: "mid" })!), null);
  });
});
