// Phase 1B gate: TypeScript candidate pools must equal the Python goldens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../candidates.ts";
import { policyFromJson, emptyPolicy } from "../policy.ts";
import { posterior } from "../bandit.ts";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./golden/${n}`, import.meta.url), "utf8"));
const g = load("candidates.json");
const post = load("posterior.json");
const pol = policyFromJson(1, { schema: 1, templates: g.mined, sites: g.sites });

const view = (c: C.Candidate) => ({
  template_id: c.templateId, query: c.query, gl: c.gl, hl: c.hl, site: c.site, origin: c.origin,
  signature: C.signature(c), tokens: [...C.tokens(c)].sort(),
});
const views = (cs: C.Candidate[]) => cs.map(view);

test("golden coverage", () => {
  assert.ok(g.cases.length >= 150);
  for (const k of ["fixed", "mutation", "mined", "learned"])
    assert.ok(g.cases.reduce((n: number, c: any) => n + c[k].length, 0) > (k === "learned" ? 30 : 100), k);
});
test("all pools equal Python for every fingerprint", () => {
  for (const c of g.cases) {
    const ctx = JSON.stringify(c.fp);
    assert.deepEqual(C.slotsFor(c.fp), c.slots, ctx);
    assert.deepEqual(views(C.fixedCandidates(c.fp)), c.fixed, ctx);
    assert.deepEqual(views(C.mutationCandidates(c.fp)), c.mutation, ctx);
    assert.deepEqual(views(C.minedCandidates(pol, c.fp)), c.mined, ctx);
    assert.deepEqual(views(C.learnedSiteCandidates(pol, c.fp)), c.learned, ctx);
    g.ident_sets.forEach((q: string[], i: number) => assert.deepEqual(views(C.identCandidates(q, c.fp)), c.ident[i], ctx + i));
  }
});
test("slug equals Python", () => {
  for (const s of g.slugs) assert.equal(C.slug(s.in), s.out, JSON.stringify(s.in));
});
test("fill equals Python", () => {
  for (const f of g.fills) assert.equal(C.fill(f.pattern, { item: "A  B", brand: null, x: "" }), f.out, f.pattern);
});
test("posterior equals Python golden (1e-9)", () => {
  const p = policyFromJson(2, { schema: 1, arms: post.arms, prior: { rate: post.prior_rate, strength: post.prior_strength } });
  for (const r of post.posteriors) {
    const x = posterior(p, r.ctx, r.t);
    assert.ok(Math.abs(x.alpha - r.alpha) < 1e-9 && Math.abs(x.beta - r.beta) < 1e-9, JSON.stringify(r));
    assert.equal(x.nGlobal, r.ng);
    assert.equal(x.nSpecific, r.ns);
  }
  assert.equal(emptyPolicy().version, 0);
});
test("SOLD_WORD has Japanese and unicode boundaries", () => {
  assert.ok(C.SOLD_WORD.test("ニコン 落札"));
  assert.ok(!C.SOLD_WORD.test("åsåld"));
});
