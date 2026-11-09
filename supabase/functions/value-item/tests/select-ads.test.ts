import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeFindings, DEFAULT_BELIEF, JUDGE_MAX_ADS, reliabilityOf, selectFindings, updateBelief } from "../select-ads.ts";
import type { Finding } from "../types.ts";

type Ad = Omit<Finding, "id">;
const ad = (i: number, usd: number, site = `s${i}.se`, kind: "sold" | "asking" = "sold", title = `Item model ${i} unique${i}`, searchId = "s1", tier: Ad["tier"] = "local"): Ad => ({
  searchId, title, snippet: "", url: `https://${site}/${i}`, site, kind, price: usd, currency: "USD", priceUsd: usd, gl: "se", origin: "SE", tier,
});

describe("select-ads: the statistical selector", () => {
  it("is deterministic and numbers from 1", () => {
    const all = Array.from({ length: 12 }, (_, i) => ad(i, 90 + i * 2));
    const a = analyzeFindings(all).chosen;
    const b = analyzeFindings(all).chosen;
    assert.deepEqual(a, b);
    assert.deepEqual(a.map((f) => f.id), a.map((_, i) => i + 1));
  });

  it("the Judge gets JUDGE_MAX_ADS ads first and the total is capped at 16", () => {
    const all = Array.from({ length: 30 }, (_, i) => ad(i, 100 + (i % 5)));
    const { chosen, trace } = analyzeFindings(all);
    assert.equal(chosen.length, 16);
    assert.equal(trace.rows.length, 16);
    assert.ok(JUDGE_MAX_ADS === 7);
  });

  it("drops a typo and a lot (outliers) from the Judge's slots without any price threshold", () => {
    const all = [...Array.from({ length: 9 }, (_, i) => ad(i, 95 + i * 2)), ad(100, 5), ad(101, 900)];
    const { chosen } = analyzeFindings(all);
    const head = chosen.slice(0, JUDGE_MAX_ADS).map((f) => f.priceUsd);
    assert.ok(!head.includes(5) && !head.includes(900), `got ${head.join(",")}`);
  });

  it("a clone of a chosen ad adds almost nothing: diversity of sites wins", () => {
    const clones = Array.from({ length: 6 }, (_, i) => ad(i, 100, "same.se", "sold", "Seiko 5 SNK809 automatic watch", "s1"));
    const others = Array.from({ length: 4 }, (_, i) => ad(50 + i, 100 + i, `o${i}.se`, "sold", `Different words here ${i} abc${i}`, `s${i + 2}`));
    const { chosen } = analyzeFindings([...clones, ...others], { judgeSlots: 5, max: 10 });
    const fromSame = chosen.slice(0, 5).filter((f) => f.site === "same.se").length;
    assert.ok(fromSame <= 2, `${fromSame} clones in the first 5`);
  });

  it("sold comes first among the Judge's slots, local before foreign", () => {
    const all = [ad(1, 100, "a.se", "asking", "x1 aa", "s1", "local"), ad(2, 100, "b.com", "sold", "x2 bb", "s2", "global"), ad(3, 100, "c.se", "sold", "x3 cc", "s3", "local")];
    const out = selectFindings(all);
    assert.deepEqual(out.map((f) => f.kind), ["sold", "sold", "asking"]);
    assert.deepEqual(out.slice(0, 2).map((f) => f.tier), ["local", "global"]);
  });

  it("information gain is positive and falls as ads are added (diminishing returns)", () => {
    const all = Array.from({ length: 10 }, (_, i) => ad(i, 100 + i, `h${i}.se`));
    const { trace } = analyzeFindings(all);
    const g = trace.rows.map((r) => r.gain);
    assert.ok(g.every((x) => x > 0));
    assert.ok(g[0] > g[g.length - 1]);
    assert.ok(trace.sdLogJudgeSet < 0.1);
  });

  it("handles empty input, one ad, and unpriced ads without throwing", () => {
    assert.deepEqual(selectFindings([]), []);
    assert.equal(selectFindings([ad(1, 50)]).length, 1);
    const bad = ad(2, NaN);
    assert.equal(selectFindings([bad, ad(3, 60)]).length, 2);
    assert.equal(selectFindings([bad, ad(3, 60)])[0].priceUsd, 60);
  });

  it("a distrusted source (Search AI belief) is chosen later", () => {
    const all = [ad(1, 100, "bad.se"), ad(2, 100, "good.se", "sold", "other words zz", "s2")];
    const first = (b: (f: Ad) => { alpha: number; beta: number } | undefined) => analyzeFindings(all, { judgeSlots: 1, max: 2, belief: b }).chosen[0].site;
    assert.equal(first((f) => (f.site === "bad.se" ? { alpha: 1, beta: 30 } : { alpha: 30, beta: 1 })), "good.se");
    assert.equal(first((f) => (f.site === "good.se" ? { alpha: 1, beta: 30 } : { alpha: 30, beta: 1 })), "bad.se");
  });

  it("the belief update is conjugate, clamped and can forget", () => {
    const b = DEFAULT_BELIEF("sold");
    const u = updateBelief(b, 4, 5);
    assert.equal(u.alpha, b.alpha + 4);
    assert.equal(u.beta, b.beta + 1);
    assert.ok(reliabilityOf(updateBelief(b, 0, 10)) < reliabilityOf(b));
    assert.equal(updateBelief(b, 99, 5).beta, b.beta);
    assert.ok(updateBelief(b, 0, 0, 0.5).alpha < b.alpha);
  });

  it("the trace feeds Search AI: per site ads delivered and inlier mass", () => {
    const { trace } = analyzeFindings([...Array.from({ length: 6 }, (_, i) => ad(i, 100 + i)), ad(9, 2000, "junk.se")]);
    const junk = trace.sourceEvidence.find((e) => e.site === "junk.se");
    assert.ok(junk && junk.n === 1 && junk.inlierMass < 0.2);
  });
});
