// JUDGE_EFFORT=auto: the effort is picked by code (pickEffort), before the Judge call, with no extra model call.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeEffortOf } from "../config.ts";
import { adsConflict, EFFORT, judge, pickEffort } from "../judge.ts";
import type { EffortSignals } from "../judge.ts";
import { runBrain } from "../pipeline.ts";
import { getFxTable } from "../fx.ts";
import type { AuthenticityReport, BrainInput, Finding, Identification } from "../types.ts";
import {
  FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, json, makeDeps, sampleVerdict, serperSold, sleepMs,
  stepOf, streamJudge, testConfig,
} from "./helpers.ts";

const finding = (id: number, over: Partial<Finding> = {}): Finding => ({
  id, searchId: "s1", title: `Seiko 5 SNK809 watch ${id}`, snippet: "", url: `https://x.test/${id}`, site: "x.test", kind: "sold",
  price: 60, currency: "USD", priceUsd: 60, gl: "se", origin: "SE", tier: "local", ...over,
});
const sold = (n: number, over: Partial<Finding> = {}) => Array.from({ length: n }, (_, i) => finding(i + 1, over));

const identOk: Identification = { ...SAMPLE_IDENT, category: "backpack", brand: "Fjallraven", model: "Kanken", era: null, confidence: 90, new_price_usd: 80, new_price_basis: "known_model" };
const authOk: AuthenticityReport = { signs: [], era: null, risk_hint: "low", search_terms: [] };
const kanken = (n: number, over: Partial<Finding> = {}) => sold(n, { title: "Fjallraven Kanken backpack", ...over });
const easy = (): EffortSignals => ({ ident: identOk, authenticity: authOk, findings: kanken(6), memoryHit: false, memoryAgeDays: null, memoryMaxAgeDays: null });

describe("JUDGE_EFFORT setting", () => {
  it("auto is the default; unknown and empty values mean auto; the manual levels stay", () => {
    assert.equal(judgeEffortOf(undefined), "auto");
    assert.equal(judgeEffortOf(""), "auto");
    assert.equal(judgeEffortOf("banana"), "auto");
    assert.equal(judgeEffortOf(" AUTO "), "auto");
    for (const v of ["medium", "high"]) assert.equal(judgeEffortOf(v), v);
    for (const v of ["off", "low", "OFF"]) assert.equal(judgeEffortOf(v), "auto", "off and low no longer exist");
  });
});

describe("pickEffort", () => {
  it("an easy scan is MEDIUM, with the reason default_medium", () => {
    const p = pickEffort("auto", easy());
    assert.deepEqual(p, { effort: "medium", auto: true, reasons: ["default_medium"] });
  });

  it("a manual setting is returned as it is, whatever the signals", () => {
    for (const v of ["medium", "high"] as const) {
      const p = pickEffort(v, { ...easy(), ident: null });
      assert.equal(p.effort, v);
      assert.equal(p.auto, false);
      assert.deepEqual(p.reasons, ["manual"]);
    }
  });

  const cases: [string, Partial<EffortSignals>, string][] = [
    ["Identification not identifiable", { ident: { ...identOk, identifiable: false } }, "ident_not_identifiable"],
    ["Identification certainty low", { ident: { ...identOk, confidence: 40 } }, "ident_certainty_low"],
    ["Authenticity eye risk medium", { authenticity: { ...authOk, risk_hint: "medium" } }, "authenticity_risk_medium"],
    ["Authenticity eye risk high", { authenticity: { ...authOk, risk_hint: "high" } }, "authenticity_risk_high"],
    ["watches", { ident: { ...identOk, category: "watch" } }, "high_value_category"],
    ["jewelry", { ident: { ...identOk, category: "jewellery" } }, "high_value_category"],
    ["art", { ident: { ...identOk, category: "oil painting" } }, "high_value_category"],
    ["antiques by category", { ident: { ...identOk, category: "antique clock" } }, "high_value_category"],
    ["antiques by age class", { ident: { ...identOk, age_class: "antique" } }, "high_value_category"],
    ["antiques by the Authenticity eye's era", { authenticity: { ...authOk, era: "Victorian" } }, "high_value_category"],
    ["Memory HIT older than half the max age", { memoryHit: true, memoryAgeDays: 16, memoryMaxAgeDays: 30 }, "memory_hit_old"],
  ];
  for (const [name, over, reason] of cases) {
    it(`HIGH: ${name}`, () => {
      const p = pickEffort("auto", { ...easy(), ...over });
      assert.equal(p.effort, "high");
      assert.ok(p.reasons.includes(reason), `${reason} in ${p.reasons.join(",")}`);
      assert.ok(!p.reasons.includes("default_medium"));
    });
  }

  const mediumCases: [string, Partial<EffortSignals>][] = [
    ["Identification failed or late", { ident: null }],
    ["Authenticity eye failed or late", { authenticity: null }],
    ["no sold ads (only asking ads)", { findings: kanken(4, { kind: "asking" }) }],
    ["no ads at all", { findings: [] }],
    ["thin market (fewer than 5 effective sold)", { findings: kanken(4) }],
    ["thin market counted by tier (5 global sold are about 2.7)", { findings: kanken(5, { tier: "global" }) }],
    ["electronics", { ident: { ...identOk, category: "electronics" } }],
  ];
  for (const [name, over] of mediumCases) {
    it(`MEDIUM (default_medium): ${name}`, () => {
      assert.deepEqual(pickEffort("auto", { ...easy(), ...over }), { effort: "medium", auto: true, reasons: ["default_medium"] });
    });
  }

  it("everything missing at once (no Identification, no Authenticity eye, no ads) is still MEDIUM", () => {
    const p = pickEffort("auto", { ident: null, authenticity: null, findings: [], memoryHit: false, memoryAgeDays: null, memoryMaxAgeDays: null });
    assert.deepEqual(p, { effort: "medium", auto: true, reasons: ["default_medium"] });
  });

  it("a fresh Memory HIT (not older than half the max age) stays MEDIUM; a non-HIT age does not count", () => {
    assert.equal(pickEffort("auto", { ...easy(), memoryHit: true, memoryAgeDays: 14, memoryMaxAgeDays: 30 }).effort, "medium");
    assert.equal(pickEffort("auto", { ...easy(), memoryHit: false, memoryAgeDays: 29, memoryMaxAgeDays: 30 }).effort, "medium");
  });

  it("conflicting brands or models among the ads no longer raise the effort: MEDIUM", () => {
    const mixed = [...kanken(3), ...sold(3, { title: "Eastpak Padded backpack" })].map((f, i) => ({ ...f, id: i + 1 }));
    assert.ok(adsConflict(mixed, identOk).length > 0, "the ads really do conflict");
    assert.deepEqual(pickEffort("auto", { ...easy(), findings: mixed }), { effort: "medium", auto: true, reasons: ["default_medium"] });
  });

  it("auto NEVER returns off or low, whatever the signals", () => {
    const idents: (Identification | null)[] = [null, identOk, { ...identOk, identifiable: false }, { ...identOk, confidence: 10 }, { ...identOk, category: "watch" }];
    const auths: (AuthenticityReport | null)[] = [null, authOk, { ...authOk, risk_hint: "high" }];
    const finds = [[], kanken(2), kanken(8)];
    for (const ident of idents) for (const authenticity of auths) for (const findings of finds) for (const memoryHit of [false, true]) {
      const p = pickEffort("auto", { ident, authenticity, findings, memoryHit, memoryAgeDays: 20, memoryMaxAgeDays: 30 });
      assert.ok(p.effort === "medium" || p.effort === "high", p.effort);
      assert.ok(p.reasons.length > 0);
    }
  });

  it("is pure: the signals are not changed", () => {
    const s = easy();
    const frozen = JSON.stringify(s);
    pickEffort("auto", s);
    assert.equal(JSON.stringify(s), frozen);
  });

  it("adsConflict needs three ads and a real split on both sides", () => {
    assert.deepEqual(adsConflict(kanken(2), identOk), []);
    assert.deepEqual(adsConflict(kanken(6), identOk), [], "all ads agree");
    assert.deepEqual(adsConflict(sold(6, { title: "Eastpak Padded" }), identOk), [], "no ad agrees: that is another problem, not a split");
    assert.deepEqual(adsConflict(kanken(6), null), []);
  });
});

describe("judge(): the effort it is given", () => {
  const input: BrainInput = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };
  const stats = { findingCount: 5, soldCount: 5, soldTarget: 5, stopReason: "target" };
  const ads = sold(5);
  const callWith = async (cfgOver: Record<string, unknown>, effort?: "medium" | "high") => {
    const { deps, calls } = makeDeps((_c, signal) => streamJudge(sampleVerdict(), signal));
    await judge(deps, testConfig(cfgOver), input, SAMPLE_IDENT, SAMPLE_DETAILS, ads, stats, 2000, null, null, effort);
    return calls[0].body as Record<string, unknown>;
  };
  it("sends the effort it is given (medium)", async () => {
    const b = await callWith({}, "medium");
    assert.deepEqual(b.thinking, { type: "adaptive" });
    assert.deepEqual(b.output_config, { effort: "medium" });
  });
  it("with the setting auto and no effort given it falls back to high (the old default), never off", async () => {
    const b = await callWith({ judgeEffort: "auto" });
    assert.deepEqual(b.output_config, { effort: "high" });
  });
  it("a manual setting is honoured when no effort is given", async () => {
    assert.deepEqual((await callWith({ judgeEffort: "medium" })).output_config, { effort: "medium" });
    const hi = await callWith({ judgeEffort: "high" });
    assert.deepEqual(hi.thinking, { type: "adaptive" }, "thinking is never off");
  });
  it("the Judge never receives Identification: its request carries nothing from it", async () => {
    const { deps, calls } = makeDeps((_c, signal) => streamJudge(sampleVerdict(), signal));
    const secret = { ...SAMPLE_IDENT, display_name: "ZQXUNIQUEIDENTNAME", what_is_it: "ZQXUNIQUEWHAT", model: "ZQXMODEL9" };
    await judge(deps, testConfig(), input, secret, SAMPLE_DETAILS, ads, stats, 2000, null, null, "medium");
    const sent = JSON.stringify(calls[0].body);
    assert.ok(!sent.includes("ZQXUNIQUE") && !sent.includes("ZQXMODEL9"), "no Identification text in the Judge request");
  });
});

describe("pipeline: the effort is chosen before the Judge call and logged", () => {
  const input: BrainInput = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };
  const PLAN = {
    ok: true, strategy_version: 4,
    searches: [
      { id: "s1", query: "kanken sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" },
      { id: "s2", query: "kanken såld", template_id: "fx_local_sold", kind: "exploit", gl: "se", hl: "sv" },
    ],
    stop: { sold_prices: 5, max_ms: 2000 },
  };
  const bag = { ...SAMPLE_IDENT, category: "backpack", display_name: "Fjallraven Kanken backpack", brand: "Fjallraven", model: "Kanken", era: null, confidence: 90, google_queries: ["kanken sold"] };
  function route(identOver: Record<string, unknown> = {}, authOver: Record<string, unknown> = {}, soldN = 6) {
    return async (call: { url: string; body?: Record<string, unknown> }, signal?: AbortSignal) => {
      if (call.url.includes("anthropic")) {
        const step = stepOf(call as never);
        if (step === "detail") return claudeReply(SAMPLE_DETAILS);
        if (step === "auth") return claudeReply({ ...SAMPLE_AUTH, ...authOver });
        if (step === "ident") return claudeReply({ ...bag, ...identOver });
        if (step === "judge") return streamJudge(sampleVerdict({ brand: "Fjallraven", model: "Kanken", category: "backpack", display_name: "Fjallraven Kanken" }), signal);
      }
      if (call.url.includes("serper")) {
        await sleepMs(20, signal);
        const r = serperSold(soldN, 60, "a", "www.tradera.com");
        const data = await r.json();
        for (const o of data.organic) o.title = `Fjallraven Kanken backpack ${o.title.slice(-2)}`;
        return json(data);
      }
      return json({}, 404);
    };
  }
  async function run(r: ReturnType<typeof route>, cfgOver = {}) {
    const { deps, calls, clock } = makeDeps(r as never);
    const out = await runBrain(input, testConfig(cfgOver), deps, { fx: getFxTable(deps, null), memory: null, localPlan: fakeEngine(PLAN, { calls, clock }) });
    const judgeCall = calls.find((c) => stepOf(c) === "judge")!;
    return { out, calls, judgeCall };
  }

  it("an easy scan: MEDIUM is sent and logged with its reason, and there is no extra model call", async () => {
    const { out, calls, judgeCall } = await run(route());
    const trace = out.steps.judgeTrace as Record<string, unknown>;
    assert.deepEqual(trace.effortReasons, ["default_medium"], JSON.stringify(trace));
    assert.equal(trace.effort, "medium");
    assert.equal(trace.effortAuto, true);
    assert.deepEqual(judgeCall.body?.output_config, { effort: "medium" });
    assert.equal(calls.filter((c) => stepOf(c) === "judge").length, 1, "one Judge call only");
    assert.equal(calls.filter((c) => c.url.includes("anthropic")).length, calls.filter((c) => ["detail", "ident", "auth", "judge", "secondLook"].includes(stepOf(c))).length, "no new kind of model call");
  });

  it("a risky scan: the Authenticity eye says medium risk, so HIGH is sent and the reason is logged", async () => {
    const { out, judgeCall } = await run(route({}, { risk_hint: "medium" }));
    const trace = out.steps.judgeTrace as Record<string, unknown>;
    assert.equal(trace.effort, "high");
    assert.ok((trace.effortReasons as string[]).includes("authenticity_risk_medium"));
    assert.deepEqual(judgeCall.body?.output_config, { effort: "high" });
  });

  it("a watch is HIGH (high-value category)", async () => {
    const { out } = await run(route({ category: "watch" }));
    assert.ok(((out.steps.judgeTrace as Record<string, unknown>).effortReasons as string[]).includes("high_value_category"));
  });

  it("a manual JUDGE_EFFORT overrides auto for every scan", async () => {
    const { out, judgeCall } = await run(route({}, { risk_hint: "high" }), { judgeEffort: "medium" });
    assert.deepEqual(judgeCall.body?.output_config, { effort: "medium" });
    assert.deepEqual((out.steps.judgeTrace as Record<string, unknown>).effortReasons, ["manual"]);
  });

  it("Judge thinking is never off in auto, even when everything is missing", async () => {
    const { judgeCall } = await run(route({ identifiable: true, confidence: 10 }, { risk_hint: "high" }, 1));
    assert.deepEqual(judgeCall.body?.thinking, { type: "adaptive" });
  });
});

describe("Authenticity eye search", () => {
  it("withEyeSearch uses only the Authenticity eye (never Detail eye text) and adds nothing without terms", async () => {
    const { withEyeSearch } = await import("../pipeline.ts");
    const plan = { searches: [{ id: "s1", query: "seiko snk809", template_id: "t", kind: "fixed", gl: "se", hl: "sv", reason: "x" }], stop: { soldPrices: 5, maxMs: 3000 } } as never;
    const details = { details: [{ kind: "stamp", text: "ZQXSTAMP" }], condition: { grade: "good", details: "" }, authenticity_signals: [] } as never;
    assert.equal(withEyeSearch(plan, details, null), plan, "Detail eye alone adds nothing");
    const out = withEyeSearch(plan, details, { signs: [], era: "1970s", risk_hint: "low", search_terms: ["vintage"] } as never) as { extraSearches: { query: string }[] };
    assert.ok(out.extraSearches[0].query.includes("vintage") && !out.extraSearches[0].query.includes("ZQXSTAMP"));
  });
});
