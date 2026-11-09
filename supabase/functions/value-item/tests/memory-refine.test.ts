// Memory, refined (tasks 7 and 8): who may get IN, who may come OUT, how old, and the Detail eye (and the Judge)
// that Memory no longer skips. No real calls, no cost.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ageClassOf, ageDecay, checkStored, corroborates, detailRaisesAuthenticity, gradeDistance, isSpecificBrand, isSpecificModel,
  isTrustedBrainVersion, judgeAgreesWithIdent, maxAgeDaysFor, memoryGate, memoryKey, MEMORY_AGE_DECAY_MAX, selectStored,
  storableReason, storedAsFindings, buildFingerprint,
} from "../memory.ts";
import { runBrain } from "../pipeline.ts";
import type { MemoryPort } from "../pipeline.ts";
import { getFxTable } from "../fx.ts";
import type { BrainInput, DetailReport } from "../types.ts";
import {
  FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, json, makeDeps, sampleResult, sampleVerdict, serperSold, sleepMs,
  stepOf, streamJudge, storedValuation, testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = Date.now();
const cfg = testConfig();
const fpSE = buildFingerprint(SAMPLE_IDENT, "SE");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const details = (grade: DetailReport["condition"]["grade"], over: Partial<DetailReport> = {}): DetailReport => ({
  ...SAMPLE_DETAILS,
  condition: { grade, details: `looks ${grade}` },
  ...over,
});

// ---------------------------------------------------------------- the item must be specific

describe("Memory: only a specific item is recognised", () => {
  it("rejects placeholder brands and models, so two different items never meet under 'unknown' or 'classic'", () => {
    for (const bad of ["unknown", "Unknown", "n/a", "classic", "Standard", "vintage", "generic", "unbranded", "no name", "", "X"]) {
      assert.equal(isSpecificModel(bad), false, `model "${bad}"`);
    }
    for (const bad of ["unbranded", "No brand", "unknown", "generic", "", "-"]) {
      assert.equal(isSpecificBrand(bad), false, `brand "${bad}"`);
    }
    assert.equal(isSpecificModel("SNK809"), true);
    assert.equal(isSpecificModel("Air Max 90"), true);
    assert.equal(isSpecificModel("5"), false, "one character is not a model");
    assert.equal(isSpecificBrand("Seiko"), true);

    const generic = buildFingerprint({ ...SAMPLE_IDENT, model: "Classic" }, "SE");
    assert.equal(memoryKey(generic), null);
    const noBrand = buildFingerprint({ ...SAMPLE_IDENT, brand: "Unbranded" }, "SE");
    assert.equal(memoryKey(noBrand), null);
    assert.equal(memoryKey(fpSE), "m1|seiko|snk809|SE", "an honest key is exactly what it was");
  });

  it("only looks in Memory when Identification is at least 80 sure (it used to be 60)", () => {
    assert.equal(cfg.memoryMinIdentConfidence, 80);
  });
});

// ---------------------------------------------------------------- prices age

describe("Memory: prices age, so the age limit depends on the kind of item", () => {
  it("sorts items into fast, normal and slow", () => {
    for (const c of ["smartphone", "laptop", "games console", "graphics card", "headphones", "tablet", "tv"]) assert.equal(ageClassOf(c), "fast", c);
    for (const c of ["antique", "painting", "coin", "stamps", "book", "porcelain", "trading card"]) assert.equal(ageClassOf(c), "slow", c);
    for (const c of ["watch", "guitar", "sneakers", "axe", "", null, undefined, "flag"]) assert.equal(ageClassOf(c as string), "normal", String(c));
    assert.equal(ageClassOf("vintage computer"), "fast", "fast wins when both could apply");
  });

  it("gives 10, 30 and 90 days, and the SHORTER limit when the stored and the new category disagree", () => {
    assert.equal(maxAgeDaysFor(cfg, "smartphone"), 10);
    assert.equal(maxAgeDaysFor(cfg, "watch"), 30);
    assert.equal(maxAgeDaysFor(cfg, "antique"), 90);
    assert.equal(maxAgeDaysFor(cfg, "antique", "tablet"), 10);
    assert.equal(maxAgeDaysFor(cfg, "book", "watch"), 30);
    assert.equal(maxAgeDaysFor(cfg), 30, "no category: normal");
  });

  it("refuses a phone valuation after 10 days but still serves a watch valuation at 25", () => {
    const phone = storedValuation({ createdAt: ago(12) }, { category: "smartphone" });
    const watch = storedValuation({ createdAt: ago(25) }, { category: "watch" });
    assert.deepEqual(checkStored(phone, cfg, NOW, "SE", "smartphone"), { ok: false, reason: "too_old" });
    assert.equal(checkStored(watch, cfg, NOW, "SE", "watch").ok, true);
    assert.deepEqual(checkStored(storedValuation({ createdAt: ago(95) }, { category: "antique" }), cfg, NOW, "SE", "antique"), { ok: false, reason: "too_old" });
    assert.equal(checkStored(storedValuation({ createdAt: ago(80) }, { category: "antique" }), cfg, NOW, "SE", "antique").ok, true);
  });

  it("an old valuation is a little less sure: up to 15 points off, none when new", () => {
    assert.equal(ageDecay(0, 30), 0);
    assert.equal(ageDecay(15, 30), Math.round(MEMORY_AGE_DECAY_MAX / 2));
    assert.equal(ageDecay(30, 30), MEMORY_AGE_DECAY_MAX);
    assert.equal(ageDecay(300, 30), MEMORY_AGE_DECAY_MAX, "never more than the maximum");
  });
});

// ---------------------------------------------------------------- reading: every rule has a name

describe("Memory: a stored valuation must pass every rule", () => {
  const fresh = (resultOver = {}, over = {}) => storedValuation({ createdAt: ago(2), ...over }, resultOver);
  const why = (s: ReturnType<typeof storedValuation>) => {
    const c = checkStored(s, cfg, NOW, "SE", "watch");
    return c.ok ? "ok" : c.reason;
  };

  it("passes a good valuation", () => assert.equal(why(fresh()), "ok"));

  it("refuses each kind of doubt, with its reason", () => {
    assert.equal(why(fresh({}, { memoryEligible: false })), "not_eligible");
    assert.equal(why(fresh({}, { brainVersion: "brain-4.0.0" })), "old_version", "rows saved under the looser rules never answer");
    assert.equal(why(fresh({}, { brainVersion: null })), "old_version");
    assert.equal(why(fresh({ status: "needs_photo" })), "not_a_valuation");
    assert.equal(why(fresh({ market: undefined })), "no_market", "a valuation that does not say which market it is for is not trusted");
    assert.equal(why(fresh({ market: { country: "DE", basis: "local", local: 5, regional: 0, global: 0 } })), "other_market");
    assert.equal(why(fresh({ market: { country: "SE", basis: "global", local: 0, regional: 0, global: 5 } })), "weak_evidence");
    assert.equal(why(fresh({ market: { country: "SE", basis: "none", local: 0, regional: 0, global: 0 } })), "weak_evidence");
    assert.equal(why(fresh({ authenticityFlag: "check" })), "authenticity");
    assert.equal(why(fresh({ confidenceScore: 30 })), "low_confidence");
    assert.equal(why(fresh({ low: 10, high: 100 })), "too_wide");
    assert.equal(why(fresh({ comparables: [] })), "few_listings");
    assert.equal(why(fresh({}, { createdAt: "not a date" })), "bad_date");
    assert.equal(why(fresh({}, { createdAt: new Date(NOW + 3 * DAY).toISOString() })), "bad_date");
    assert.equal(why(fresh({}, { createdAt: ago(45) })), "too_old");
  });

  it("allows a regional (neighbouring market) basis", () => {
    assert.equal(why(fresh({ market: { country: "SE", basis: "regional", local: 1, regional: 4, global: 0 } })), "ok");
  });

  it("trusts only Brain versions at or above the first with the strict rules", () => {
    // brain-5.1.0 = Judge-driven prices + estimate mode: 4.x and 5.0 memory is ignored on purpose (prices changed meaning).
    assert.equal(isTrustedBrainVersion("brain-4.1.0"), false);
    assert.equal(isTrustedBrainVersion("brain-4.2.7"), false);
    assert.equal(isTrustedBrainVersion("brain-5.0.0"), false);
    assert.equal(isTrustedBrainVersion("brain-5.1.0"), true);
    assert.equal(isTrustedBrainVersion("brain-5.1.3"), true);
    assert.equal(isTrustedBrainVersion("brain-4.0.9"), false);
    assert.equal(isTrustedBrainVersion("brain-3.9.9"), false);
    assert.equal(isTrustedBrainVersion("nonsense"), false);
    assert.equal(isTrustedBrainVersion(undefined), false);
  });
});

describe("Memory: several saved valuations of the same item must agree", () => {
  const row = (mid: number, days: number, condition: "good" | "fair" = "good", runId = `r${mid}`) =>
    storedValuation({ runId, createdAt: ago(days) }, { mid, low: mid * 0.8, high: mid * 1.25, condition });

  it("uses the newest when they agree", () => {
    const s = selectStored([row(60, 1), row(66, 6)], "good", cfg, NOW, "SE", "watch");
    assert.equal(s.reason, "ok");
    assert.equal(s.stored?.result.mid, 60);
  });

  it("uses none when two valuations of the same item and condition disagree by more than 1.6x", () => {
    const s = selectStored([row(60, 1), row(120, 6)], "good", cfg, NOW, "SE", "watch");
    assert.equal(s.stored, null);
    assert.equal(s.reason, "peers_disagree");
  });

  it("lets valuations of another condition differ (condition costs money)", () => {
    const s = selectStored([row(60, 1, "good"), row(120, 3, "fair")], "good", cfg, NOW, "SE", "watch");
    assert.equal(s.stored?.result.mid, 60);
    assert.equal(s.reason, "ok");
  });

  it("prefers the valuation whose condition is closest to what the Detail eye sees now, even if older", () => {
    const s = selectStored([row(55, 1, "fair"), row(60, 8, "good")], "good", cfg, NOW, "SE", "watch");
    assert.equal(s.stored?.result.mid, 60);
  });

  it("explains itself when nothing qualifies", () => {
    assert.equal(selectStored([], "good", cfg, NOW, "SE", "watch").reason, "no_valuations");
    const old = selectStored([storedValuation({ createdAt: ago(60) })], "good", cfg, NOW, "SE", "watch");
    assert.equal(old.stored, null);
    assert.equal(old.reason, "too_old");
  });
});

// ---------------------------------------------------------------- the Detail eye is not skipped

describe("Memory gate: the Detail eye must agree before a stored price is reused", () => {
  const stored = storedValuation({ createdAt: ago(1) });

  it("HIT: same condition and the brand is readable on the item", () => {
    assert.deepEqual(memoryGate(stored, fpSE, details("good"), cfg), { outcome: "hit", reason: "same_item_same_condition" });
  });

  it("MISS without the Detail eye", () => {
    assert.deepEqual(memoryGate(stored, fpSE, null, cfg), { outcome: "miss", reason: "no_detail" });
  });

  it("JUDGE: condition one grade away, with saved listings to re-check", () => {
    assert.equal(memoryGate(stored, fpSE, details("fair"), cfg).outcome, "judge");
    assert.equal(memoryGate(stored, fpSE, details("like-new"), cfg).outcome, "judge");
  });

  it("MISS: condition two grades or more away", () => {
    assert.deepEqual(memoryGate(stored, fpSE, details("poor"), cfg), { outcome: "miss", reason: "condition_far" });
    assert.deepEqual(memoryGate(stored, fpSE, details("new"), cfg), { outcome: "miss", reason: "condition_far" });
  });

  it("MISS: one grade away but only one saved listing to reuse", () => {
    const thin = storedValuation({ createdAt: ago(1) }, { comparables: storedValuation().result.comparables.slice(0, 1) });
    assert.equal(memoryGate(thin, fpSE, details("fair"), cfg).outcome, "miss");
  });

  it("MISS: the Detail eye sees signs of a fake", () => {
    const fake = details("good", { authenticity_signals: ["logo font looks wrong"] });
    assert.deepEqual(memoryGate(stored, fpSE, fake, cfg), { outcome: "miss", reason: "fake_signs" });
    assert.equal(detailRaisesAuthenticity(details("good", { authenticity_signals: ["clean stitching, matching serial"] })), false);
    assert.equal(detailRaisesAuthenticity(details("good", { details: [{ kind: "logo", text: "replica logo" }] })), true);
    assert.equal(detailRaisesAuthenticity(details("good", { details: [{ kind: "damage", text: "uneven fading" }] })), false, "wear is not a fake sign");
  });

  it("MISS: nothing the Detail eye reads matches what Identification said (a lone witness is not enough)", () => {
    const unrelated = details("good", { details: [{ kind: "material", text: "Steel bracelet" }] });
    assert.deepEqual(memoryGate(stored, fpSE, unrelated, cfg), { outcome: "miss", reason: "not_corroborated" });
    // ... unless the owner turns the rule off.
    assert.equal(memoryGate(stored, fpSE, unrelated, testConfig({ memoryRequireCorroboration: false })).outcome, "hit");
  });

  it("corroboration needs whole words: SNK809K1 on the item does not confirm SNK809", () => {
    const noBrand = { ...fpSE, brand: "acme" };
    assert.equal(corroborates(noBrand, details("good", { details: [{ kind: "serial", text: "SNK809K1" }] })), false);
    assert.equal(corroborates(noBrand, details("good", { details: [{ kind: "serial", text: "SNK809" }] })), true);
    assert.equal(corroborates(fpSE, details("good", { details: [{ kind: "logo", text: "SEIKO 5" }] })), true);
    assert.equal(corroborates({ ...fpSE, brand: "acme", model: "5" }, details("good", { details: [{ kind: "label", text: "5 bar" }] })), false, "a short model proves nothing");
  });

  it("measures condition distance", () => {
    assert.equal(gradeDistance("good", "good"), 0);
    assert.equal(gradeDistance("good", "fair"), 1);
    assert.equal(gradeDistance("new", "poor"), 4);
  });
});

// ---------------------------------------------------------------- getting IN

describe("Memory: what may be stored for reuse", () => {
  const goodResult = storedValuation().result;
  const args = (over = {}) => ({
    cfg,
    key: "m1|seiko|snk809|SE",
    judgeRan: true,
    result: goodResult,
    ident: SAMPLE_IDENT,
    verdict: sampleVerdict(),
    keptCount: 5,
    degraded: [] as string[],
    ...over,
  });

  it("accepts a well-founded valuation", () => assert.equal(storableReason(args()), null));

  it("keeps out every kind of doubt", () => {
    assert.equal(storableReason(args({ key: null })), "no_key");
    assert.equal(storableReason(args({ judgeRan: false })), "no_judge");
    for (const flag of ["judge_partial", "judge_emergency", "detail_eye_failed", "detail_eye_late", "fx_fallback", "memory_judged"]) {
      assert.equal(storableReason(args({ degraded: [flag] })), flag);
    }
    assert.equal(storableReason(args({ ident: { ...SAMPLE_IDENT, confidence: 70 } })), "identification_unsure");
    assert.equal(storableReason(args({ result: { ...goodResult, authenticityFlag: "check" } })), "authenticity");
    assert.equal(storableReason(args({ result: { ...goodResult, needsMoreInfo: "take a closer photo" } })), "needs_more_info");
    assert.equal(storableReason(args({ keptCount: 2 })), "few_listings");
    assert.equal(storableReason(args({ result: { ...goodResult, confidenceScore: 40 } })), "low_confidence");
    assert.equal(storableReason(args({ result: { ...goodResult, low: 10, high: 90 } })), "too_wide");
    assert.equal(storableReason(args({ result: { ...goodResult, market: { country: "SE", basis: "global", local: 0, regional: 0, global: 5 } } })), "weak_evidence");
    assert.equal(storableReason(args({ result: { ...goodResult, market: undefined } })), "weak_evidence");
  });

  it("keeps out a valuation when the Judge, looking at the photo alone, names another model than Identification", () => {
    assert.equal(judgeAgreesWithIdent(SAMPLE_IDENT, sampleVerdict()), true);
    assert.equal(judgeAgreesWithIdent(SAMPLE_IDENT, sampleVerdict({ model: "SNK803" })), false);
    assert.equal(judgeAgreesWithIdent(SAMPLE_IDENT, sampleVerdict({ brand: "Casio" })), false);
    assert.equal(judgeAgreesWithIdent(SAMPLE_IDENT, sampleVerdict({ model: null })), false, "an unconfirmed model is not confirmed");
    assert.equal(judgeAgreesWithIdent(SAMPLE_IDENT, sampleVerdict({ model: "snk 809" })), false, "a different spelling is not trusted either");
    assert.equal(storableReason(args({ verdict: sampleVerdict({ model: "SNK803" }) })), "judge_disagrees");
  });
});

describe("Memory: reusing the saved listings", () => {
  it("turns the stored comparables into findings for the Judge, sold first, prices untouched", () => {
    const f = storedAsFindings(storedValuation());
    assert.equal(f.length, 4);
    assert.deepEqual(f.map((x) => x.id), [1, 2, 3, 4]);
    assert.deepEqual(f.map((x) => x.kind), ["sold", "sold", "sold", "asking"]);
    assert.equal(f[0].priceUsd, 59);
    assert.equal(f[0].site, "tradera.com");
    assert.equal(f[0].tier, "local");
    assert.equal(f[0].origin, "SE");
  });
});

// ---------------------------------------------------------------- the whole Brain

const input: BrainInput = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };
const PLAN = {
  ok: true, strategy_version: 4,
  searches: [{ id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "se", hl: "sv" }],
  stop: { sold_prices: 5, max_ms: 2000 },
};

interface Over {
  detail?: () => Response | Promise<Response>;
  ident?: () => Response | Promise<Response>;
  judge?: (call: Call, signal?: AbortSignal) => Response | Promise<Response>;
}

function route(o: Over = {}): Route {
  return async (call, signal) => {
    if (call.url.includes("anthropic")) {
      const step = stepOf(call);
      if (step === "detail") return o.detail ? o.detail() : claudeReply(SAMPLE_DETAILS);
      if (step === "auth") return claudeReply(SAMPLE_AUTH);
      if (step === "ident") return o.ident ? o.ident() : claudeReply(SAMPLE_IDENT);
      if (step === "judge") return o.judge ? o.judge(call, signal) : streamJudge(sampleVerdict(), signal);
    }
    if (call.url.includes("serper")) return serperSold(5, 60, "a", "www.tradera.com");
    return json({}, 404);
  };
}

const memoryOf = (...rows: ReturnType<typeof storedValuation>[]): MemoryPort & { asked: number } => {
  const port = { asked: 0, find: async () => { port.asked += 1; return rows; } };
  return port;
};
const count = (calls: Call[], part: string) => calls.filter((c) => c.url.includes(part)).length;
const judgeCalls = (calls: Call[]) => calls.filter((c) => stepOf(c) === "judge");

async function run(o: Over, memory: MemoryPort | null, cfgOver = {}) {
  const { deps, calls, clock } = makeDeps(route(o));
  const out = await runBrain(input, testConfig(cfgOver), deps, { fx: getFxTable(deps, null), memory, localPlan: fakeEngine(PLAN, { calls, clock }) });
  return { out, calls };
}

describe("the Brain with Memory: the Detail eye and the Judge are connected", () => {
  it("HIT: runs the Detail eye, shows what it sees now, skips search, and goes straight to the Judge", async () => {
    const fresh = details("good", { condition: { grade: "good", details: "clean, light wear on clasp" } });
    const { out, calls } = await run({ detail: () => claudeReply(fresh) }, memoryOf(storedValuation()));
    assert.equal(out.memoryHit, true);
    assert.equal(calls.filter((c) => stepOf(c) === "detail").length, 1, "the Detail eye ran");
    assert.equal(count(calls, "serper"), 0);
    assert.equal(count(calls, "search-ai"), 0);
    assert.equal(judgeCalls(calls).length, 1, "a HIT goes straight to the Judge (orange line in the diagram)");
    const condition = out.result.factors.find((f) => f.label === "Condition");
    assert.ok(condition?.detail.includes("clean, light wear on clasp"), "the Condition line comes from the photo in hand");
    assert.ok(!out.result.factors.some((f) => f.detail === "old photo wear."), "the old condition text is gone");
    assert.ok(out.result.factors.some((f) => f.label === "Memory"));
    assert.deepEqual((out.steps.memory as { outcome: string }).outcome, "hit");
  });

  it("HIT: an older valuation is a little less sure than a new one", async () => {
    const newer = await run({}, memoryOf(storedValuation({ createdAt: ago(0) }, { confidenceScore: 80 })));
    const older = await run({}, memoryOf(storedValuation({ createdAt: ago(24) }, { confidenceScore: 80 })));
    assert.ok(older.out.result.confidenceScore < newer.out.result.confidenceScore);
    assert.ok(newer.out.result.confidenceScore - older.out.result.confidenceScore >= 8);
  });

  it("MISS, full Brain, when the Detail eye is not available (Memory never answers unseen)", async () => {
    const { out, calls } = await run({ detail: () => json({ error: "x" }, 500) }, memoryOf(storedValuation()));
    assert.equal(out.memoryHit, false);
    assert.equal(judgeCalls(calls).length, 1);
    assert.ok(count(calls, "serper") >= 1);
    assert.equal((out.steps.memory as { reason: string }).reason, "no_detail");
  });

  it("waits only a short while for a slow Detail eye, then runs the full Brain inside the 7 s limit", async () => {
    const t0 = Date.now();
    const { out, calls } = await run(
      { detail: async () => { await sleepMs(3500); return claudeReply(SAMPLE_DETAILS); } },
      memoryOf(storedValuation()),
    );
    const ms = Date.now() - t0;
    assert.equal(out.memoryHit, false);
    assert.equal((out.steps.memory as { reason: string }).reason, "no_detail");
    assert.equal(judgeCalls(calls).length, 1, "the Brain still ran");
    const memoryAt = (out.steps.timing as { memory: number }).memory;
    assert.ok(memoryAt <= 2700, `Memory gave up waiting at ${memoryAt} ms`);
    assert.ok(ms < 6900, `answered in ${ms} ms`);
  });

  it("MISS when the condition is far from the stored one", async () => {
    const { out, calls } = await run({ detail: () => claudeReply(details("poor")) }, memoryOf(storedValuation()));
    assert.equal(out.memoryHit, false);
    assert.equal(judgeCalls(calls).length, 1);
    assert.equal((out.steps.memory as { reason: string }).reason, "condition_far");
  });

  it("MISS when the Detail eye sees signs of a fake", async () => {
    const { out } = await run({ detail: () => claudeReply(details("good", { authenticity_signals: ["stitching looks inconsistent"] })) }, memoryOf(storedValuation()));
    assert.equal(out.memoryHit, false);
    assert.equal((out.steps.memory as { reason: string }).reason, "fake_signs");
  });

  it("MISS when nothing the Detail eye reads confirms what Identification said", async () => {
    const { out } = await run(
      { detail: () => claudeReply(details("good", { details: [{ kind: "material", text: "steel bracelet" }] })) },
      memoryOf(storedValuation()),
    );
    assert.equal(out.memoryHit, false);
    assert.equal((out.steps.memory as { reason: string }).reason, "not_corroborated");
  });

  it("does not even look in Memory when Identification is only 70 sure", async () => {
    const memory = memoryOf(storedValuation());
    const { out } = await run({ ident: () => claudeReply({ ...SAMPLE_IDENT, confidence: 70 }) }, memory);
    assert.equal(memory.asked, 0);
    assert.equal(out.memoryHit, false);
  });

  it("does not look in Memory for a placeholder model", async () => {
    const memory = memoryOf(storedValuation());
    const { out } = await run({ ident: () => claudeReply({ ...SAMPLE_IDENT, model: "Classic" }) }, memory);
    assert.equal(memory.asked, 0);
    assert.equal(out.memoryEligible, false, "and such a valuation is never stored for reuse either");
  });

  it("MISS when two saved valuations of the same item disagree", async () => {
    const a = storedValuation({ runId: "a", createdAt: ago(1) }, { mid: 60, low: 48, high: 75 });
    const b = storedValuation({ runId: "b", createdAt: ago(5) }, { mid: 130, low: 100, high: 160 });
    const { out } = await run({}, memoryOf(a, b));
    assert.equal(out.memoryHit, false);
    assert.equal((out.steps.memory as { reason: string }).reason, "peers_disagree");
  });

  it("MISS for a phone valuation older than 10 days, which a watch would still be allowed at that age", async () => {
    const phoneIdent = { ...SAMPLE_IDENT, category: "smartphone", display_name: "Seiko phone" };
    const old = storedValuation({ createdAt: ago(15) }, { category: "smartphone" });
    const phone = await run({ ident: () => claudeReply(phoneIdent) }, memoryOf(old));
    assert.equal(phone.out.memoryHit, false);
    assert.equal((phone.out.steps.memory as { reason: string }).reason, "too_old");
    const watch = await run({}, memoryOf(storedValuation({ createdAt: ago(15) })));
    assert.equal(watch.out.memoryHit, true);
  });

  describe("JUDGE: condition one grade away", () => {
    const fair = () => claudeReply(details("fair", { condition: { grade: "fair", details: "visible scratches" } }));

    it("sends the saved listings and the Detail eye's report to the Judge, with no new search", async () => {
      const { out, calls } = await run(
        { detail: fair, judge: (_c, s) => streamJudge(sampleVerdict({ condition: { grade: "fair", details: "scratches" }, same: [1, 2, 3, 4], ads: [1, 2, 3, 4].map((id) => ({ id, match: "same" as const, condition_vs_ad: "worse" as const })) }), s) },
        memoryOf(storedValuation({ createdAt: ago(7) })),
      );
      assert.equal(count(calls, "serper"), 0, "no new search");
      assert.equal(count(calls, "search-ai"), 0);
      const judge = judgeCalls(calls);
      assert.equal(judge.length, 1);
      const sys = String(judge[0].body?.system);
      assert.match(sys, /did not search today/);
      assert.match(sys, /7 days ago/);
      const user = JSON.stringify(judge[0].body?.messages);
      assert.ok(user.includes("visible scratches"), "the Judge sees the Detail eye's report");
      assert.ok(user.includes("Seiko 5 SNK809 automatic watch 1"), "the Judge sees the saved listings");
      assert.ok(user.includes("saved ads from an earlier valuation"));
      assert.equal((judge[0].body?.messages as { content: { type: string }[] }[])[0].content[0].type, "image", "and the photo");

      assert.equal(out.result.status, "ok");
      assert.ok(out.result.mid > 40 && out.result.mid < 60, "a re-valued price for the fair condition, not the stored one");
      assert.equal(out.result.condition, "fair");
      assert.ok(out.result.degraded.includes("memory_judged"));
      assert.ok(out.result.factors.some((f) => f.label === "Market" && /7 days ago/.test(f.detail)));
      assert.equal((out.steps.memory as { outcome: string }).outcome, "judge");
    });

    it("is saved as a valuation of its own, but never becomes Memory itself", async () => {
      const { out } = await run({ detail: fair }, memoryOf(storedValuation({ createdAt: ago(3) })));
      assert.equal(out.saveable, true);
      assert.equal(out.memoryEligible, false, "an answer built on memory must not refresh memory's clock");
      assert.equal(out.memoryHit, false);
      assert.equal(out.searchLog.length, 0);
    });

    it("falls back to the saved valuation, clearly less sure, if the Judge cannot answer", async () => {
      const { out } = await run({ detail: fair, judge: () => json({ error: "overloaded" }, 500) }, memoryOf(storedValuation({ createdAt: ago(3) }, { confidenceScore: 85 })));
      assert.equal(out.result.status, "ok");
      assert.equal(out.memoryHit, true);
      assert.equal(out.saveable, false);
      assert.ok(out.result.confidenceScore <= 40);
      assert.ok(out.result.degraded.includes("memory_condition_unverified"));
      assert.ok(out.result.factors.some((f) => /condition looks different/.test(f.detail)));
    });
  });
});

describe("the Brain: a new valuation only enters Memory when it is surely right", () => {
  it("is eligible when everything lines up (Swedish listings, five kept, Judge agrees)", async () => {
    const { out } = await run({}, null);
    assert.equal(out.memoryEligible, true);
    assert.deepEqual(out.steps.memoryStore, { eligible: true, reason: null });
  });

  it("is NOT eligible when the Judge names another model than Identification did", async () => {
    const { out } = await run({ judge: (_c, s) => streamJudge(sampleVerdict({ model: "SNK803" }), s) }, null);
    assert.equal(out.result.status, "ok");
    assert.equal(out.memoryEligible, false);
    assert.equal((out.steps.memoryStore as { reason: string }).reason, "judge_disagrees");
  });

  it("is NOT eligible when Identification was only 75 sure", async () => {
    const { out } = await run({ ident: () => claudeReply({ ...SAMPLE_IDENT, confidence: 75 }) }, null);
    assert.equal(out.memoryEligible, false);
    assert.equal((out.steps.memoryStore as { reason: string }).reason, "identification_unsure");
  });

  it("is NOT eligible when the evidence is foreign (American listings for a Swedish user)", async () => {
    const { deps } = makeDeps(async (call, signal) => {
      if (call.url.includes("serper")) { await sleepMs(20, signal); return serperSold(5, 60, "f"); }
      return route()(call, signal);
    });
    const out = await runBrain(input, testConfig(), deps, { fx: getFxTable(deps, null), memory: null, localPlan: fakeEngine(PLAN) });
    assert.equal(out.result.status, "ok");
    assert.equal(out.memoryEligible, false);
    assert.equal((out.steps.memoryStore as { reason: string }).reason, "weak_evidence");
  });

  it("the sample result of the old tests stays a valid result (nothing else changed shape)", () => {
    assert.equal(sampleResult().status, "ok");
  });
});
