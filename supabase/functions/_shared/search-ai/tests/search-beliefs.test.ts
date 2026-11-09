import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SourceBook } from "../beliefs.ts";
import { analyzeFindings, DEFAULT_BELIEF, reliabilityOf } from "../../../value-item/select-ads.ts";
import type { Finding } from "../../../value-item/types.ts";

type Ad = Omit<Finding, "id">;
const ad = (i: number, usd: number, site: string, kind: "sold" | "asking" = "sold"): Ad => ({
  searchId: "s1", title: `Item model ${i} u${i}`, snippet: "", url: `https://${site}/${i}`, site, kind, price: usd, currency: "USD", priceUsd: usd, gl: "se", origin: "SE", tier: "local",
});
const rel = (b: SourceBook, site: string) => { const x = b.belief({ site, kind: "sold" }); return reliabilityOf(x); };

describe("SourceBook: Search AI's trust per source", () => {
  it("unknown source = default prior", () => {
    const b = new SourceBook();
    assert.deepEqual(b.belief({ site: "x.se", kind: "sold" }), DEFAULT_BELIEF("sold"));
  });
  it("a clean source gains trust, a dirty one loses it, and one search cannot swing it far", () => {
    const b = new SourceBook();
    for (let i = 0; i < 40; i++) b.record([{ site: "clean.se", kind: "sold", n: 5, inlierMass: 5 }, { site: "dirty.se", kind: "sold", n: 5, inlierMass: 1 }]);
    assert.ok(rel(b, "clean.se") > reliabilityOf(DEFAULT_BELIEF("sold")));
    assert.ok(rel(b, "dirty.se") < 0.6);
    const c = new SourceBook();
    c.record([{ site: "one.se", kind: "sold", n: 500, inlierMass: 0 }]);
    assert.ok(rel(c, "one.se") > 0.6, "capped per call");
  });
  it("weight is bounded and load/flush round-trip increments", async () => {
    const b = new SourceBook();
    for (let i = 0; i < 2000; i++) b.record([{ site: "a.se", kind: "asking", n: 4, inlierMass: 3 }]);
    const s = b.snapshot().find((x) => x.site === "a.se")!;
    assert.ok(s.a + s.b <= 400 + 1e-6);
    const sent: unknown[][] = [];
    await b.flush({ loadSourceBeliefs: async () => [], addSourceBelief: async (...a) => { sent.push(a); } });
    assert.equal(sent.length, 1);
    await b.flush({ loadSourceBeliefs: async () => [], addSourceBelief: async () => { throw new Error("x"); } }); // nothing pending: no throw
  });
  it("a failed flush keeps the increment for next time", async () => {
    const b = new SourceBook();
    b.record([{ site: "a.se", kind: "sold", n: 2, inlierMass: 2 }]);
    await b.flush({ loadSourceBeliefs: async () => [], addSourceBelief: async () => { throw new Error("down"); } });
    const sent: unknown[][] = [];
    await b.flush({ loadSourceBeliefs: async () => [], addSourceBelief: async (...a) => { sent.push(a); } });
    assert.equal(sent.length, 1);
  });
  it("pooled prior moves a never-seen source once the market is known", () => {
    const b = new SourceBook();
    for (let i = 0; i < 30; i++) b.record([{ site: `k${i}.se`, kind: "asking", n: 4, inlierMass: 1 }]);
    assert.ok(reliabilityOf(b.belief({ site: "new.se", kind: "asking" })) < reliabilityOf(DEFAULT_BELIEF("asking")));
  });
  it("the selector trusts the learned source: a distrusted site's ad is picked later", () => {
    const mk = () => [...Array.from({ length: 9 }, (_, i) => ad(i, 100 + i, `ok${i}.se`)), ad(20, 100, "bad.se")];
    const book = new SourceBook();
    for (let i = 0; i < 60; i++) book.record([{ site: "bad.se", kind: "sold", n: 4, inlierMass: 0.4 }]);
    const posOf = (opts?: Parameters<typeof analyzeFindings>[1]) => analyzeFindings(mk(), { judgeSlots: 5, ...opts }).chosen.findIndex((f) => f.site === "bad.se");
    const without = analyzeFindings(mk(), { judgeSlots: 5 }).trace.rows.find((r) => r.site === "bad.se")!;
    const withB = analyzeFindings(mk(), { judgeSlots: 5, belief: (f) => book.belief(f) }).trace.rows.find((r) => r.site === "bad.se")!;
    assert.ok(withB.reliability < without.reliability);
    assert.ok(withB.gain <= without.gain + 1e-9);
    void posOf;
  });
  it("evidence from the selector has a kind and feeds the book", () => {
    const { trace } = analyzeFindings([ad(1, 100, "a.se"), ad(2, 101, "a.se", "asking"), ad(3, 99, "b.se")]);
    assert.ok(trace.sourceEvidence.every((e) => e.kind === "sold" || e.kind === "asking"));
    const b = new SourceBook();
    b.record(trace.sourceEvidence);
    assert.equal(b.snapshot().length, trace.sourceEvidence.length);
  });
});

import { judgeEvidence } from "../beliefs.ts";
describe("Judge as a second teacher + UCB", () => {
  it("judgeEvidence: same/clean counts, different does not, unpriced ignored", () => {
    const f = [1, 2, 3, 4].map((id) => ({ id, site: "a.se", kind: "sold", priceUsd: id === 4 ? 0 : 100 }));
    const ev = judgeEvidence(f, [{ id: 1, match: "same", p_same: "certain" }, { id: 2, match: "different" }, { id: 3, match: "similar", ad_reliability: "low" }, { id: 4, match: "same" }]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].n, 3);
    assert.ok(Math.abs(ev[0].inlierMass - (1 + 0 + 0.35)) < 1e-9);
  });
  it("record strength scales evidence", () => {
    const a = new SourceBook(); const b = new SourceBook();
    a.record([{ site: "x.se", kind: "sold", n: 2, inlierMass: 0 }], 1);
    b.record([{ site: "x.se", kind: "sold", n: 2, inlierMass: 0 }], 2);
    assert.ok(rel(b, "x.se") < rel(a, "x.se"));
  });
  it("optimism favours the uncertain source over an equally reliable but well-known one, and is off by default", () => {
    const ads = [...Array.from({ length: 6 }, (_, i) => ad(i, 100 + i, `known${i}.se`)), ad(9, 100, "new.se")];
    const belief = (f: { site: string; kind: string }) => (f.site === "new.se" ? { alpha: 8.8, beta: 1.2 } : { alpha: 176, beta: 24 });
    const at = (o?: number) => analyzeFindings(ads, { judgeSlots: 4, belief, optimism: o }).trace.rows.find((r) => r.site === "new.se")!.pickedAt;
    assert.ok(at(2) <= at(0));
    assert.equal(at(undefined), at(0));
  });
});
