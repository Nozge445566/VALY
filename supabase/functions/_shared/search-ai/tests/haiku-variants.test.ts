import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { plan, VARIANT_MIN_OBS, CONTROL_MIN_OBS } from "../planner.ts";
import { policyFromJson } from "../policy.ts";
import { haikuVariants, identCandidates } from "../candidates.ts";
import { cleanFingerprint, contextKeys } from "../fingerprint.ts";
import { fixedPlan } from "../../../value-item/fixed-templates.ts";

const g = JSON.parse(readFileSync(new URL("./golden/planner.json", import.meta.url), "utf8"));
type Out = { ok: boolean; searches?: { query: string; template_id: string }[] };
const mean = (p: { alpha: number; beta: number }) => p.alpha / p.beta;

function firstCase() {
  for (const c of g.cases) {
    const fp = cleanFingerprint(c.raw);
    if (!fp || !Array.isArray(c.ident) || c.ident.length === 0) continue;
    const h = identCandidates(c.ident, fp)[0];
    if (!h) continue;
    const out = plan(policyFromJson(c.version, c.policy), c.raw, c.ident, () => 0.5, mean) as Out;
    if (out.ok) return { c, fp, h };
  }
  throw new Error("no case");
}

test("variants: control is first and exact; variants use idv: arm ids and never repeat a query", () => {
  const { fp, h } = firstCase();
  const v = haikuVariants(h, fp);
  assert.equal(v[0], h);
  assert.equal(new Set(v.map((x) => x.query.toLowerCase())).size, v.length);
  for (const x of v.slice(1)) assert.ok(x.templateId.startsWith("idv:"));
});

test("no data for any variant: slot 4 is Haiku's exact query; the other 3 never contain it", () => {
  let n = 0;
  for (const c of g.cases) {
    const fp = cleanFingerprint(c.raw);
    if (!fp || !Array.isArray(c.ident) || !c.ident.length) continue;
    const h = identCandidates(c.ident, fp)[0];
    if (!h) continue;
    const out = plan(policyFromJson(c.version, c.policy), c.raw, c.ident, () => 0.5, mean) as Out;
    if (!out.ok) continue;
    const qs = out.searches!.map((s) => s.query);
    assert.equal(qs[qs.length - 1], h.query);
    assert.equal(qs.slice(0, -1).filter((q) => q === h.query).length, 0);
    n++;
  }
  assert.ok(n >= 20);
});

test("a variant with data and a better score wins slot 4; slot 4 is never empty", () => {
  const { c, fp, h } = firstCase();
  const variant = haikuVariants(h, fp)[1];
  assert.ok(variant, "need a variant");
  const ctx = contextKeys(fp);
  const pol = JSON.parse(JSON.stringify(c.policy));
  // inject strong stats for the variant arm under the most general context (format: arms[ctx][template] = [k, t, n])
  const arms = pol.arms ?? (pol.arms = {});
  const key = ctx[0];
  arms[key] = arms[key] ?? {};
  arms[key][variant.templateId] = [50, 5, VARIANT_MIN_OBS + 10];
  const out = plan(policyFromJson(c.version, pol), c.raw, c.ident, () => 0.5, mean) as Out;
  assert.ok(out.ok);
  const last = out.searches![out.searches!.length - 1];
  assert.equal(last.query, variant.query);
  assert.equal(last.template_id, variant.templateId);
  assert.ok(CONTROL_MIN_OBS > 0);
});

test("Search AI and Connector import nothing from each other", () => {
  const dir = new URL("..", import.meta.url);
  for (const f of readdirSync(dir)) if (f.endsWith(".ts")) assert.ok(!/connector/i.test(readFileSync(new URL(f, dir), "utf8").split("\n").filter((l) => /^import/.test(l)).join("\n")), f);
  assert.ok(!/search-ai/.test(readFileSync(new URL("../../connector-learn.ts", import.meta.url), "utf8").split("\n").filter((l) => /^import/.test(l)).join("\n")));
});

test("fallback fixedPlan: Haiku's query is in the plan at the 4-search cap, and is not crowded out", () => {
  let n = 0;
  for (const c of g.cases) {
    const fp = cleanFingerprint(c.raw);
    if (!fp || !Array.isArray(c.ident) || !c.ident.length) continue;
    const q = String(c.ident[0]).replace(/\s+/g, " ").trim();
    if (q.length < 3 || q.length > 120) continue;
    const p = fixedPlan(fp as never, c.ident);
    assert.ok(p.searches.length <= 4);
    assert.ok(p.searches.some((s) => s.query.toLowerCase() === q.toLowerCase()), `crowded out: ${q}`);
    n++;
  }
  assert.ok(n >= 10);
});
