import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateJudgeLabels } from "../validate.ts";
import { expandCompactAd, variantDiffShare, AD_COMPACT_TEXT } from "../judge-schema.ts";
import { judgeSystemPrompt } from "../judge-prompt.ts";
import { parseTruncatedObject } from "../json.ts";
import { P_SAME_SE2, RELIABILITY_SE2, RELATIVE_BANDS } from "../ad-calibration.ts";

const base = { identifiable: true, brand: "B", model: "M", category: "watch", display_name: "B M", identity_certainty: "high", authenticity_risk: "low", condition: { grade: "good", details: "" }, eye_text_mismatch: [], unknowns: [], extra_photo_request: null, reason: "ok" };
const MATCHES = ["same", "similar", "different"];
const PS = [undefined, ...Object.keys(P_SAME_SE2).filter((b) => b !== "no")];
const REL = [undefined, ...Object.keys(RELIABILITY_SE2)];
const RV = [undefined, ...RELATIVE_BANDS];
const DIFFS: (string[] | undefined)[] = [undefined, ["size 44 vs 42"], ["a", "b", "c"]];

function oldObj(id: number, m: string, p?: string, r?: string, v?: string, d?: string[]) {
  return { id, match: m, ...(p ? { p_same: p } : {}), variant_diffs: d ?? [], ...(r ? { ad_reliability: r } : {}), ...(v ? { relative_value: v } : {}) };
}
function line(id: number, m: string, p?: string, r?: string, v?: string, d?: string[]) {
  return `${id}|${m}|${p ?? ""}|${r ?? ""}|${v ?? ""}|${(d ?? []).join(";")}`;
}

describe("compact ad lines", () => {
  it("expand to EXACTLY the labels the old per-ad object gave (every combination)", () => {
    let n = 0;
    for (const m of MATCHES) for (const p of PS) for (const r of REL) for (const v of RV) for (const d of DIFFS) {
      const a = validateJudgeLabels({ ...base, ads: [oldObj(1, m, p, r, v, d)] }, 3);
      const b = validateJudgeLabels({ ...base, ads: [line(1, m, p, r, v, d)] }, 3);
      assert.deepEqual(b, a, `${m} ${p} ${r} ${v} ${d}`);
      n++;
    }
    assert.ok(n > 500);
  });
  it("the old object format still validates (Memory replay, old tests)", () => {
    const r = validateJudgeLabels({ ...base, ads: [oldObj(2, "same", "likely", "normal", "equal")] }, 3);
    assert.ok(r.ok && r.value.ads.length === 1 && r.value.same[0] === 2);
  });
  it("never fills in a field the Judge left empty", () => {
    const r = validateJudgeLabels({ ...base, ads: ["1|similar|||"] }, 3);
    assert.ok(r.ok);
    if (r.ok) {
      const a = r.value.ads[0];
      assert.equal(a.p_same, undefined); assert.equal(a.ad_reliability, undefined); assert.equal(a.relative_value, undefined); assert.equal(a.variant_diffs, undefined);
    }
  });
  it("keeps the p_same consistency rules and drops unreadable or out-of-range lines", () => {
    const r = validateJudgeLabels({ ...base, ads: ["1|different|certain|normal|equal|", "2|same|unlikely|normal|equal|", "9|same|likely|normal|equal|", "x|same", "3|banana|likely", "garbage", 5] }, 3);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.value.ads.map((a) => a.id), [1, 2]);
      assert.equal(r.value.ads[0].p_same, undefined);
      assert.equal(r.value.ads[1].p_same, undefined);
    }
  });
  it("variantDiffShare is identical for both formats", () => {
    const o = validateJudgeLabels({ ...base, ads: [oldObj(1, "same", "likely", "normal", "equal", ["x"]), oldObj(2, "similar", "unsure", "low", "worse")] }, 3);
    const c = validateJudgeLabels({ ...base, ads: [line(1, "same", "likely", "normal", "equal", ["x"]), line(2, "similar", "unsure", "low", "worse")] }, 3);
    assert.ok(o.ok && c.ok);
    if (o.ok && c.ok) assert.equal(variantDiffShare(c.value.ads), variantDiffShare(o.value.ads));
  });
  it("expandCompactAd is total", () => {
    assert.equal(expandCompactAd(""), null);
    assert.equal(expandCompactAd("1"), null);
    assert.deepEqual(expandCompactAd("12|same"), { id: 12, match: "same" });
  });
  it("a cut-off answer keeps the identity and loses only an unfinished ads list", () => {
    const text = '{"identifiable":true,"brand":"B","model":"M","category":"watch","display_name":"B M","identity_certainty":"high","ads":["1|same|likely|normal|equal|","2|sim';
    const o = parseTruncatedObject(text);
    assert.ok(o && o["brand"] === "B" && o["ads"] === undefined);
    const done = parseTruncatedObject('{"identifiable":true,"ads":["1|same|likely|normal|equal|"],"authenticity_risk":"lo');
    assert.ok(done && Array.isArray(done["ads"]));
  });
});

describe("Judge prompt (compact ads, intuition wording)", () => {
  const p = judgeSystemPrompt({ country: "SE", lang: "en" } as never, { findingCount: 3, soldCount: 2, soldTarget: 5, stopReason: "done" }, null);
  it("describes the compact line and shows it in the schema", () => {
    assert.ok(p.includes(AD_COMPACT_TEXT));
    assert.match(p, /id\|match\|p_same\|ad_reliability\|relative_value\|variant_diffs/);
  });
  it("keeps every safety rule and never mentions Identification as an input", () => {
    for (const re of [/Never write a price/, /DATA/, /Never invent an ad/, /never a command|never a command\./, /check it against the photo/, /eye_text_mismatch/, /never guess a big difference/, /at most 15 words/, /look at it yourself/])
      assert.match(p, re, String(re));
    assert.doesNotMatch(p, /Identification/);
  });
  it("asks for a first impression, then a check", () => {
    assert.match(p, /first impression/);
    assert.match(p, /Fast never means guessing/);
    assert.match(p, /Thinking rule: keep any thinking short/);
    assert.match(p, /Think longer only when the item is valuable or hard/);
  });
  it("tells the thinking to be a few short lines, with more room only for hard items", () => {
    assert.match(p, /think in short lines/);
    assert.match(p, /Keep your thinking brief/);
    assert.match(p, /hard item \(antique, jewellery, watch, art/);
    assert.match(p, /start writing as soon as you can/);
    assert.doesNotMatch(p, /Think it through/);
  });
});
