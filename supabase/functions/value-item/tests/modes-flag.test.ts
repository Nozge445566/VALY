// Valuation modes (always on): the retail and reference anchors, and mode templates only on non-resale fingerprints.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorEstimate } from "../anchor.ts";
import { fixedPlan, modeTemplatesFor } from "../fixed-templates.ts";
import { cleanFingerprint } from "../../_shared/search-ai/fingerprint.ts";
import { fixedCandidates } from "../../_shared/search-ai/candidates.ts";
import type { Fingerprint } from "../types.ts";

const base = { new_price_usd: 100, new_price_basis: "known_model", category: "furniture", age_class: "new", condition: "new", rarity: "common" };
const fp: Fingerprint = { category: "watch", brand: "seiko", type: "automatic wristwatch", model: "snk809", era: "2010s", country: "SE", language: "sv" };

describe("anchors", () => {
  it("a comparable_objects anchor is a market value: never depreciated, no rarity multiplier", () => {
    const r = anchorEstimate({ ...base, new_price_basis: "comparable_objects" })!;
    assert.ok(r);
    assert.equal(r.parts.depreciation, 1);
    assert.equal(r.parts.rarityMult, 1);
    assert.equal(r.parts.anchor, 100);
  });
  it("a new item in new condition is valued at its retail price, not depreciated", () => {
    const r = anchorEstimate(base)!;
    assert.ok(Math.abs(r.mid - 100) < 1e-9);
  });
});

describe("fingerprint mode", () => {
  it("cleanFingerprint keeps retail/auction, drops anything else", () => {
    assert.equal(cleanFingerprint({ ...fp, mode: "retail" })?.mode, "retail");
    assert.equal(cleanFingerprint({ ...fp, mode: "auction" })?.mode, "auction");
    assert.equal("mode" in (cleanFingerprint({ ...fp, mode: "bogus" }) ?? {}), false);
  });
  it("resale fingerprint gets no mode templates; candidates identical to before", () => {
    assert.deepEqual(modeTemplatesFor(fp), []);
    assert.equal(fixedCandidates(fp).some((c) => c.templateId.startsWith("fx_retail") || c.templateId === "fx_hammer_price" || c.templateId === "fx_price_realized"), false);
  });
  it("retail and auction add their template ids first", () => {
    assert.deepEqual(modeTemplatesFor({ ...fp, mode: "retail" }).map((t) => t.id), ["fx_retail_price"]);
    assert.deepEqual(modeTemplatesFor({ ...fp, mode: "auction" }).map((t) => t.id), ["fx_hammer_price", "fx_price_realized"]);
    assert.equal(fixedCandidates({ ...fp, mode: "auction" })[0].templateId, "fx_hammer_price");
  });
  it("fixedPlan for resale is unchanged by the mode code", () => {
    const a = fixedPlan(fp, []);
    const b = fixedPlan({ ...fp }, []);
    assert.deepEqual(a, b);
  });
});
