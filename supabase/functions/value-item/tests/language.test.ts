// Swedish phone -> Swedish words. Everything else -> English. Both on the screen (src/lib) and from the Brain.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentLang, langOfLocale, uiLocale } from "../../../../src/lib/i18n.ts";
import { textsFor, driverSentences } from "../../../../src/lib/texts.ts";
import { foreignDataSentence, joinNames } from "../../../../src/lib/market.ts";
import { T, judgeLanguageRule, labelsOf, langOfBody, langOfLocale as serverLangOfLocale } from "../lang.ts";
import { buildFactors } from "../present.ts";
import { judgeSystemPrompt } from "../judge-prompt.ts";
import { memoryKey } from "../memory.ts";
import { earlyLang, handleRequest, parseRequest } from "../handler.ts";
import { verdictMessage } from "../protection.ts";
import { checkResult } from "../check.ts";
import { localizeResult } from "../localize.ts";
import type { BrainInput, BrainResult, JudgeVerdict } from "../types.ts";

/** Every key and function shape of one language must exist in the other: a missing sentence is a bug, not a fallback. */
function shape(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return [`${path}[${v.length}]`];
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => shape(x, path ? `${path}.${k}` : k));
  return [`${path}:${typeof v}`];
}

describe("language choice", () => {
  it("only Swedish phones get Swedish", () => {
    for (const l of ["sv", "sv-SE", "sv-FI", "SV_se", " sv-SE "]) assert.equal(langOfLocale(l), "sv", l);
    for (const l of ["en", "en-US", "de-DE", "da-DK", "nb-NO", "fi-FI", "fr", "", "svenska", "zh-CN"]) assert.equal(langOfLocale(l), "en", l);
    assert.equal(langOfLocale(undefined), "en");
    assert.equal(langOfLocale(null), "en");
    assert.equal(serverLangOfLocale("sv-SE"), "sv");
    assert.equal(serverLangOfLocale("nn-NO"), "en");
  });
  it("without a browser (Node) the app is English", () => {
    assert.equal(currentLang(), "en");
    assert.match(uiLocale(), /^en-[A-Za-z]{2}$/, "English phones keep an English locale");
  });
  it("the request says the language: lang wins, else the locale, else English", () => {
    assert.equal(langOfBody({ lang: "sv" }), "sv");
    assert.equal(langOfBody({ lang: "en", locale: "sv-SE" }), "en");
    assert.equal(langOfBody({ locale: "sv-SE" }), "sv");
    assert.equal(langOfBody({ lang: "de", locale: "de-DE" }), "en");
    assert.equal(langOfBody(null), "en");
    assert.equal(langOfBody("x"), "en");
  });
});

describe("screen texts: Swedish and English are complete", () => {
  it("both languages have exactly the same texts", () => {
    // factorLabels is the one exception: English has nothing to translate (an old Brain already speaks English).
    const keep = (p: string) => !p.startsWith("factorLabels");
    assert.deepEqual(shape(textsFor("sv")).filter(keep).sort(), shape(textsFor("en")).filter(keep).sort());
  });
  it("no Swedish sentence is left in English by mistake", () => {
    const sv = textsFor("sv");
    const en = textsFor("en");
    for (const k of Object.keys(en.drivers)) assert.notEqual(sv.drivers[k], en.drivers[k], k);
    assert.notEqual(sv.app.info1, en.app.info1);
  });
  it("the Swedish sentences use Swedish spelling of countries and lists", () => {
    const m = { country: "SE", basis: "global" as const, local: 0, regional: 0, global: 4, adjusted: true };
    const s = foreignDataSentence(m, [{ origin: "US", tier: "global" }, { origin: "DE", tier: "regional" }], "sv-SE")!;
    assert.match(s, /Tyskland och USA|USA och Tyskland/);
    assert.ok(s.endsWith(textsFor("sv").foreignData.adjusted));
    assert.equal(joinNames(["A", "B"], "sv"), "A och B");
    assert.equal(joinNames(["A", "B", "C"], "sv"), "A, B och C");
  });
  it("a German phone gets English words and English country names", () => {
    const m = { country: "DE", basis: "global" as const, local: 0, regional: 0, global: 4, adjusted: false };
    // the app passes uiLocale(), never the device locale, so the sentence is English
    const s = foreignDataSentence(m, [{ origin: "SE", tier: "global" }], "en-GB")!;
    assert.match(s, /Sweden/);
  });
  it("driver sentences come in the language asked for", () => {
    assert.match(driverSentences(["rarity"], textsFor("sv"))[0], /Sällsynta/);
    assert.match(driverSentences(["rarity"], textsFor("en"))[0], /Rare/);
  });
});

const verdict: JudgeVerdict = {
  identifiable: true, same: [], similar: [], price: { low: 10, mid: 20, high: 30 }, confidence: 60,
  authenticity_risk: "low", authenticity_note: "", display_name: "Test lamp", category: "Home", brand: "Ikea", model: "X1",
  condition: { grade: "like-new", details: "Few marks." }, unknowns: ["Age"], extra_photo_request: null, reason: "Common item",
} as unknown as JudgeVerdict;

describe("the Brain's texts: Swedish and English are complete", () => {
  it("both languages have exactly the same texts", () => {
    assert.deepEqual(shape(T("sv")).sort(), shape(T("en")).sort());
  });
  it("English stays the default and is unchanged", () => {
    assert.equal(T(undefined), T("en"));
    assert.equal(T("en").needsPhoto, "I can't tell what this is. Take a clear, well-lit photo of the item on its own, close enough to see details.");
  });
  it("buildFactors writes Swedish for a Swedish phone and English otherwise", () => {
    const args = { verdict, details: null, findings: [], marketState: "empty" as const, soldTarget: 5, needsMoreInfo: null };
    const en = buildFactors(args);
    const sv = buildFactors({ ...args, lang: "sv" });
    assert.equal(en[0].label, "Item");
    assert.match(en[0].detail, /Likely Ikea X1/);
    assert.equal(sv[0].label, "Föremål");
    assert.match(sv[0].detail, /Troligen Ikea X1/);
    assert.match(sv[1].detail, /^Som ny\./);
    assert.deepEqual(buildFactors({ ...args, lang: "en" }), en);
  });
  it("the Judge is only told to write Swedish for Swedish phones; the English prompt is byte-identical", () => {
    const stats = { soldCount: 3, soldTarget: 5, stopReason: "time" } as never;
    const base: BrainInput = { imageMediaType: "image/jpeg", imageBase64: "x", country: "SE" };
    const en = judgeSystemPrompt(base, stats);
    assert.equal(judgeSystemPrompt({ ...base, lang: "en" }, stats), en);
    const sv = judgeSystemPrompt({ ...base, lang: "sv" }, stats);
    assert.ok(sv.startsWith(en));
    assert.equal(sv.slice(en.length), judgeLanguageRule("sv"));
    assert.match(sv, /Swedish/);
    assert.equal(judgeLanguageRule("en"), "");
  });
  it("Swedish valuations are remembered under their own key; English keys are unchanged", () => {
    const fp = { category: "c", brand: "ikea", type: "t", model: "x1", era: null, country: "SE", language: "sv" };
    assert.equal(memoryKey(fp), "m1|ikea|x1|SE");
    assert.equal(memoryKey(fp, "en"), "m1|ikea|x1|SE");
    assert.equal(memoryKey(fp, "sv"), "m1|ikea|x1|SE|sv");
  });
  it("parseRequest carries the language and localizes its own errors", () => {
    const IMG = "data:image/png;base64," + "iVBORw0KGgo" + "A".repeat(200);
    const ok = parseRequest({ image: IMG, locale: "sv-SE", lang: "sv" }, null);
    assert.ok("req" in ok);
    if ("req" in ok) { assert.equal(ok.req.lang, "sv"); assert.equal(ok.req.input.lang, "sv"); }
    const en = parseRequest({ image: IMG, locale: "de-DE" }, null);
    if ("req" in en) { assert.equal(en.req.lang, "en"); assert.equal(en.req.input.lang, undefined, "English adds nothing to the input"); }
    const bad = parseRequest({ image: "nope", lang: "sv" }, null);
    assert.ok("error" in bad && /Fotot/.test(bad.error));
    const badEn = parseRequest({ image: "nope" }, null);
    assert.ok("error" in badEn && /photo could not be read/.test(badEn.error));
  });
  it("limit messages follow the language", () => {
    assert.match(verdictMessage("user_limit", "sv"), /Vänta/);
    assert.match(verdictMessage("user_limit"), /Please wait/);
  });
  it("authenticity and 'checked' lines are written in the phone's language, and old ones are replaced in either", () => {
    const base = {
      status: "ok", low: 10, mid: 20, high: 30, confidenceScore: 80, confidence: "high", factors: [],
      authenticityFlag: "none",
    } as unknown as BrainResult;
    const ev = { fromMemory: true, judgeRan: false, keptSoldUsd: [], keptAskingUsd: [], keptTitles: [] } as never;
    const sv = checkResult(base, ev, "high", true, "sv");
    assert.equal(sv.factors[0].label, "Äkthet");
    assert.match(sv.factors[0].detail, /kopia/);
    const again = checkResult({ ...base, factors: sv.factors }, ev, "high", true, "en");
    assert.equal(again.factors.filter((f) => labelsOf("authenticity").includes(f.label)).length, 1);
    assert.equal(again.factors[0].label, "Authenticity");
  });
  it("the exchange-rate note follows the language", () => {
    const r = { status: "ok", low: 1, mid: 2, high: 3, factors: [], comparables: [] } as unknown as BrainResult;
    const fx = { rates: { SEK: 10 }, source: "fallback", asOf: "x" } as never;
    assert.equal(localizeResult(r, fx, "SEK", "sv").factors[0].label, "Växelkurs");
    assert.equal(localizeResult(r, fx, "SEK").factors[0].label, "Exchange rate");
  });
  it("early errors (before the body is understood) speak the phone's language too", async () => {
    const mk = (init: RequestInit) => new Request("https://x.test", init);
    assert.equal(earlyLang(mk({ headers: { "accept-language": "sv-SE,sv;q=0.9,en;q=0.8" } })), "sv");
    assert.equal(earlyLang(mk({ headers: { "accept-language": "en-US,sv;q=0.9" } })), "en");
    assert.equal(earlyLang(mk({})), "en");
    assert.equal(earlyLang(mk({ headers: { "accept-language": "en" } }), '{"lang":"sv","image":"x'), "sv", "an explicit lang in the body wins");
    const ctx = { deps: { now: () => 0, log: () => {} }, getConfig: () => { throw new Error("no"); }, background: () => {}, limits: {} } as never;
    const sv = { "accept-language": "sv-SE" };
    const get = await handleRequest(mk({ method: "GET", headers: sv }), ctx);
    assert.equal(get.status, 405);
    assert.equal((await get.json()).error, T("sv").errors.usePost);
    const bad = await handleRequest(mk({ method: "POST", headers: sv, body: "{nope" }), ctx);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, T("sv").errors.invalid);
    const en = await handleRequest(mk({ method: "POST", body: "{nope" }), ctx);
    assert.equal((await en.json()).error, T("en").errors.invalid);
  });
});
