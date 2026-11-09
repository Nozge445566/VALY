// The two-way design for ALL FOUR searches (owner's picture, 1 Nov 2026):
//   IN  = the thick line: Haiku's search counts more, and how much is LEARNED (bounded, slow, shrunk toward the prior).
//   OUT = every kind of search has its own rule and its own dial: R1 local, RG global, RH Haiku.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyConnector, planKeepsRules, proposeTidy, roleOf, withoutRepeatedWords, RULE_ROLE } from "../connector.ts";
import type { ConnectorContext } from "../connector.ts";
import { loadConfig } from "../config.ts";
import { fixedPlan } from "../fixed-templates.ts";
import { buildConnectorLog, runBrain } from "../pipeline.ts";
import { getFxTable } from "../fx.ts";
import type { Fingerprint } from "../types.ts";
import {
  HAIKU_LINK_WEIGHT, HAIKU_WEIGHT_MAX, HAIKU_WEIGHT_MAX_STEP, HAIKU_WEIGHT_MIN, WEIGHT_MIN_N, haikuWeightFor, learnHaikuWeights, learnPolicy, policyKey, rewardWithHaikuWeight, weightKey,
} from "../../_shared/connector-learn.ts";
import type { LearnSearch, LogRowForLearning } from "../../_shared/connector-learn.ts";
import {
  FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, json, makeDeps, sampleVerdict, serperSold, stepOf, streamJudge, testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

/** The Search AI engine is down: the fixed templates plan the searches (same as before, now without a network). */
const searchAiDown = fakeEngine(() => { throw new Error("search ai is down"); });

// The type repeats the brand ("orrefors vase"), so the templates write "Orrefors orrefors vase": a repeated word in the
// global search. Haiku's query repeats a word. Both are the kind of thing RG and RH may remove.
const FP: Fingerprint = { category: "antiques", brand: "Orrefors", type: "orrefors vase", model: null, era: null, country: "SE", language: "sv" };
const HAIKU = ["orrefors vas tradera tradera slutpris"];
const ctx = (over: Partial<ConnectorContext> = {}): ConnectorContext => ({
  fingerprint: FP, haikuQueries: HAIKU, share: 1, minShare: 0.05, draw: 0, dial: null, rules: ["R1", "RG", "RH"], ...over,
});
const plan = () => fixedPlan(FP, HAIKU);
const q = (p: { searches: { template_id: string; query: string }[] }, id: string) => p.searches.find((s) => s.template_id === id)?.query;

describe("All four: the repeated-word edit", () => {
  it("removes a repeated word, keeps the first, and leaves operators, digits, site: and brand-internal repeats alone", () => {
    assert.equal(withoutRepeatedWords("Orrefors orrefors vase sold ebay", FP), "Orrefors vase sold ebay");
    assert.equal(withoutRepeatedWords("vase 1950 1950 site:tradera.com", FP), "vase 1950 1950 site:tradera.com", "digits are never touched");
    assert.equal(withoutRepeatedWords("vase OR OR vas", FP), "vase OR OR vas", "operators are never touched");
    const bora = { ...FP, brand: "Bora Bora" };
    assert.equal(withoutRepeatedWords("bora bora vase", bora), "bora bora vase");
  });
});

describe("All four: each rule only touches its own kind of search", () => {
  it("roles: Haiku's search, the local templates, the global templates", () => {
    const p = plan();
    const roles = Object.fromEntries(p.searches.map((s) => [s.template_id, roleOf(s, FP, HAIKU)]));
    assert.equal(roles.fx_ebay_sold, "global");
    assert.equal(roles.fx_local_sold, "local");
    assert.equal(roles.fx_local_site, "local");
    assert.equal(roles.id_fixed_1, "haiku");
    assert.deepEqual(RULE_ROLE, { R1: "local", RG: "global", RH: "haiku" });
  });

  it("RG proposes only for the global search, RH only for Haiku's", () => {
    const p = plan();
    const rg = proposeTidy(p, FP, HAIKU, "RG");
    const rh = proposeTidy(p, FP, HAIKU, "RH");
    assert.equal(rg.changes, 1);
    assert.equal(q(rg, "fx_ebay_sold"), "Orrefors vase sold ebay");
    assert.equal(q(rg, "id_fixed_1"), q(p, "id_fixed_1"));
    assert.equal(q(rg, "fx_local_site"), q(p, "fx_local_site"));
    assert.equal(rh.changes, 1);
    assert.equal(q(rh, "id_fixed_1"), "orrefors vas tradera slutpris");
    assert.equal(q(rh, "fx_ebay_sold"), q(p, "fx_ebay_sold"));
  });

  it("RH keeps every distinct word of Haiku's query (so the local name can never be lost)", () => {
    const rh = proposeTidy(plan(), FP, HAIKU, "RH");
    const before = new Set(HAIKU[0].split(" "));
    const after = new Set((q(rh, "id_fixed_1") as string).split(" "));
    assert.deepEqual([...after].sort(), [...before].sort());
    assert.ok((q(rh, "id_fixed_1") as string).includes("slutpris"));
  });

  it("a quoted query, a clean query and a query that would lose a protected part are left alone", () => {
    const clean = { ...FP, type: "vase" };
    const p = fixedPlan(clean, ["orrefors vas tradera slutpris"]);
    assert.equal(proposeTidy(p, clean, ["orrefors vas tradera slutpris"], "RG").changes, 0);
    assert.equal(proposeTidy(p, clean, ["orrefors vas tradera slutpris"], "RH").changes, 0);
    const quoted = { ...p, searches: p.searches.map((s) => (s.template_id === "fx_ebay_sold" ? { ...s, query: 'Orrefors orrefors "sold" vase' } : s)) };
    assert.equal(proposeTidy(quoted, clean, [], "RG").changes, 0);
  });
});

describe("All four: applying them", () => {
  it("all three rules on: three searches change, the number, order, ids, gl and hl do not", () => {
    const p = plan();
    const out = applyConnector(p, ctx());
    assert.equal(out.record!.applied, true);
    assert.equal(out.plan.searches.length, p.searches.length);
    assert.ok(planKeepsRules(p, out.plan));
    assert.equal(q(out.plan, "fx_ebay_sold"), "Orrefors vase sold ebay");
    assert.equal(q(out.plan, "id_fixed_1"), "orrefors vas tradera slutpris");
    const changedBy = out.record!.searches.filter((s) => s.rule).map((s) => s.rule).sort();
    assert.ok(changedBy.includes("R1") && changedBy.includes("RG") && changedBy.includes("RH"), `rules seen: ${changedBy}`);
    for (const s of out.record!.searches) {
      assert.equal(s.executed_query === s.original_query, s.rule === null, `${s.template_id}`);
    }
  });

  it("two rules that would end in the SAME query: the second is dropped, never a duplicate search and never half a change", () => {
    // Haiku repeats the sold word. R1 turns the local sold-search into exactly Haiku's tidied query.
    const dup = ["orrefors vas såld slutpris slutpris"];
    const p = fixedPlan(FP, dup);
    const out = applyConnector(p, ctx({ haikuQueries: dup }));
    const queries = out.plan.searches.map((s) => s.query.toLowerCase());
    assert.equal(new Set(queries).size, queries.length, "no duplicate searches");
    assert.ok(planKeepsRules(p, out.plan));
    const rh = out.record!.searches.find((s) => s.template_id === "id_fixed_1")!;
    assert.equal(rh.executed_query, rh.original_query);
    assert.equal(rh.skipped, "invariant_failed");
  });

  it("default: only R1 may act. RG and RH are computed and logged but change nothing", () => {
    const p = plan();
    const out = applyConnector(p, ctx({ rules: undefined }));
    assert.equal(q(out.plan, "fx_ebay_sold"), q(p, "fx_ebay_sold"));
    assert.equal(q(out.plan, "id_fixed_1"), q(p, "id_fixed_1"));
    const rg = out.record!.searches.find((s) => s.template_id === "fx_ebay_sold")!;
    assert.equal(rg.rule, "RG");
    assert.equal(rg.proposed_query, "Orrefors vase sold ebay");
    assert.equal(rg.executed_query, rg.original_query);
    assert.equal(rg.rule_on, false, "a switched-off rule is marked, so the learner ignores it");
    assert.equal(out.record!.searches.find((s) => s.template_id === "fx_local_site")!.rule_on, true);
  });

  it("each rule has its own draw: one can be treated while another is its own control", () => {
    const out = applyConnector(plan(), ctx({ share: 0.5, draws: { R1: 0.1, RG: 0.9, RH: 0.1 } }));
    assert.equal(q(out.plan, "id_fixed_1"), "orrefors vas tradera slutpris", "RH treated");
    assert.equal(q(out.plan, "fx_ebay_sold"), "Orrefors orrefors vase sold ebay", "RG is its own control");
    const rg = out.record!.searches.find((s) => s.template_id === "fx_ebay_sold")!;
    assert.equal(rg.rule_draw, 0.9);
    assert.equal(rg.rule_on, true);
    assert.equal(out.record!.applied, true);
    assert.equal(out.record!.control, false, "the valuation as a whole is treated; control is judged per rule by the learner");
  });

  it("each rule has its own dial: a dial of 0 pushes only that rule to the floor", () => {
    const out = applyConnector(plan(), ctx({ share: 1, minShare: 0.05, draws: { R1: 0.5, RG: 0.5, RH: 0.5 }, dials: { R1: null, RG: 0, RH: 1 } }));
    assert.equal(q(out.plan, "id_fixed_1"), "orrefors vas tradera slutpris", "RH dial 1: treated");
    assert.equal(q(out.plan, "fx_ebay_sold"), "Orrefors orrefors vase sold ebay", "RG dial 0: held back");
    const rg = out.record!.searches.find((s) => s.template_id === "fx_ebay_sold")!;
    assert.equal(rg.rule_dial, 0);
    assert.equal(rg.rule_share, 0.05);
  });

  it("a bad number of draws or dials never throws: the original plan comes back or the rule is simply not treated", () => {
    const p = plan();
    const out = applyConnector(p, ctx({ draws: { RG: Number.NaN }, dials: { RH: Number.NaN } }));
    assert.ok(out.record === null || planKeepsRules(p, out.plan));
  });

});

// ---------------------------------------------------------------- the learner: OUT (one dial per rule)

const srch = (rule: string | null, executed: boolean, kept: number, over: Partial<LearnSearch> = {}): LearnSearch => ({
  rule, rule_on: rule ? true : null, original_query: "a", executed_query: executed ? "b" : "a", is_haiku: false, kept_sold: kept, discarded: 0, cancelled: false, failed: false, ...over,
});
const wob = (i: number) => ((i * 7919) % 100) / 100 - 0.5;
/** One on-row: RG treated or not, RH treated or not (independent), same base yield plus an effect of each rule. */
function onRow(i: number, rgTreated: boolean, rhTreated: boolean, rgEffect: number, rhEffect: number): LogRowForLearning {
  const base = 2 + wob(i);
  return {
    mode: "on", applied: rgTreated || rhTreated, proposed_changes: 2, bucket: "SE|antiques|fixed", judge_ok: true, reward: null,
    searches: [
      srch("RG", rgTreated, base + (rgTreated ? rgEffect : 0)),
      srch("RH", rhTreated, base + (rhTreated ? rhEffect : 0), { is_haiku: true }),
      srch(null, false, base),
    ],
  };
}
// A fixed pattern that crosses the two rules, so each arm of one rule has the same mix of the other.
const grid = (n: number, rgEffect: number, rhEffect: number) =>
  Array.from({ length: n }, (_, i) => onRow(i, i % 2 === 0, i % 4 < 2, rgEffect, rhEffect));

describe("All four: the learner gives every rule its own dial", () => {
  it("RG helps and RH hurts: RG stays at 1, RH falls; the keys are prefixed, R1 keeps the plain bucket", () => {
    const t = learnPolicy(grid(240, 2, -2));
    const rg = t.find((r) => r.bucket === policyKey("RG", "SE|antiques|fixed"))!;
    const rh = t.find((r) => r.bucket === policyKey("RH", "SE|antiques|fixed"))!;
    assert.equal(policyKey("RG", "SE|antiques|fixed"), "RG@SE|antiques|fixed");
    assert.equal(policyKey("R1", "SE|antiques|fixed"), "SE|antiques|fixed");
    assert.ok(rg && rh);
    assert.equal(rg.dial, 1);
    assert.ok(rh.dial < 1 && rh.lift < 0);
    assert.ok(rg.lift > 0);
  });

  it("an effect of one rule is not blamed on another (independent draws)", () => {
    const t = learnPolicy(grid(240, 2, 0));
    const rh = t.find((r) => r.bucket === "RH@SE|antiques|fixed")!;
    assert.ok(Math.abs(rh.lift) < 0.35, `RH had no effect but lift was ${rh.lift}`);
  });

  it("entries marked rule_on:false (rule not switched on) are ignored", () => {
    const off = grid(240, 2, 2).map((r) => ({ ...r, searches: r.searches!.map((s) => ({ ...s, rule_on: false })) }));
    assert.deepEqual(learnPolicy(off), []);
  });

  it("older rows without `searches` still count as R1", () => {
    const old: LogRowForLearning[] = [
      ...Array.from({ length: 40 }, (_, i) => ({ mode: "on", applied: true, proposed_changes: 1, bucket: "SE|antiques|fixed", judge_ok: true, reward: 3 + wob(i) })),
      ...Array.from({ length: 40 }, (_, i) => ({ mode: "on", applied: false, proposed_changes: 1, bucket: "SE|antiques|fixed", judge_ok: true, reward: 1 + wob(i) })),
    ];
    assert.ok(learnPolicy(old).some((r) => r.bucket === "SE|antiques|fixed"));
  });

  it("every row is re-scored with ONE common Haiku weight, so the weight cannot bend the comparison between nights", () => {
    const a = [srch(null, false, 2), srch(null, false, 4, { is_haiku: true })];
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    assert.equal(rewardWithHaikuWeight(a, a, 3), r4((2 * 1 + 4 * 3) / 4));
    assert.equal(rewardWithHaikuWeight(a, a, 2), r4((2 * 1 + 4 * 2) / 3));
  });
});

// ---------------------------------------------------------------- the learner: IN (the learned Haiku weight)

/** A search that carries sold prices (reward v2), as the Connector's log now stores them. */
const psrch = (usd: number[], over: Partial<LearnSearch> = {}): LearnSearch => ({
  rule: null, original_query: "a", executed_query: "a", is_haiku: false, kept_sold: 0, discarded: 0, prices: usd, latency_ms: 1000, cancelled: false, failed: false, ...over,
});
/** An unmodified valuation: Haiku's search found `h` (sold prices, USD), each of the two others found `o`. */
const base = (i: number, h: number[], o: number[], mode = "shadow"): LogRowForLearning => ({
  mode, applied: false, proposed_changes: 0, bucket: "SE|antiques|fixed", judge_ok: false, reward: null,
  searches: [psrch(h, { is_haiku: true }), psrch(o), psrch(o)],
});
const HALF_RIGHT = [100, 100, 100, 300, 300]; // half of the prices are far from the market
const ALL_RIGHT = [100, 100, 100, 100, 100];

describe("All four: the learned Haiku weight (the thick line INTO the Connector)", () => {
  it("starts at the prior; the safe range keeps Haiku the strongest line and never lets it take over", () => {
    assert.equal(HAIKU_LINK_WEIGHT, 1.375);
    assert.equal(HAIKU_WEIGHT_MIN, 1.25);
    assert.equal(HAIKU_WEIGHT_MAX, 1.5);
    assert.equal(haikuWeightFor(undefined, "SE|a|fixed"), HAIKU_LINK_WEIGHT);
    assert.equal(haikuWeightFor(new Map(), "SE|a|fixed"), HAIKU_LINK_WEIGHT);
  });

  it("reads the most specific bucket, then its parents, and always clamps to the safe range", () => {
    const t = new Map([[weightKey("SE"), 1.3], [weightKey("SE|a"), 1.45]]);
    assert.equal(haikuWeightFor(t, "SE|a|fixed"), 1.45);
    assert.equal(haikuWeightFor(t, "SE|b|fixed"), 1.3);
    assert.equal(haikuWeightFor(t, "NO|a|fixed"), HAIKU_LINK_WEIGHT);
    assert.equal(haikuWeightFor(new Map([[weightKey("SE"), 99]]), "SE|a|fixed"), HAIKU_WEIGHT_MAX);
    assert.equal(haikuWeightFor(new Map([[weightKey("SE"), -5]]), "SE|a|fixed"), HAIKU_WEIGHT_MIN);
    assert.equal(haikuWeightFor(new Map([[weightKey("SE"), Number.NaN]]), "SE|a|fixed"), HAIKU_LINK_WEIGHT);
  });

  it("too little data: no weight row, the prior stays", () => {
    assert.deepEqual(learnHaikuWeights(Array.from({ length: WEIGHT_MIN_N - 1 }, (_, i) => base(i, ALL_RIGHT, HALF_RIGHT))), []);
  });

  it("Haiku finds CORRECT prices where the others are half wrong: the weight goes up, one step per night, never above the maximum", () => {
    const rows = Array.from({ length: 300 }, (_, i) => base(i, ALL_RIGHT, HALF_RIGHT));
    const first = learnHaikuWeights(rows).find((r) => r.bucket === "SE|antiques|fixed")!;
    assert.equal(first.haiku_weight, HAIKU_LINK_WEIGHT + HAIKU_WEIGHT_MAX_STEP);
    assert.ok(first.ratio > 1.4);
    let w = first.haiku_weight;
    for (let night = 0; night < 12; night++) w = learnHaikuWeights(rows, new Map([["SE|antiques|fixed", w]])).find((r) => r.bucket === "SE|antiques|fixed")!.haiku_weight;
    assert.equal(w, HAIKU_WEIGHT_MAX);
  });

  it("Haiku finds WRONG prices while the others agree: the weight goes down, but never below the minimum", () => {
    const rows = Array.from({ length: 300 }, (_, i) => base(i, [300, 300, 300], ALL_RIGHT));
    let w: number = HAIKU_LINK_WEIGHT;
    for (let night = 0; night < 12; night++) w = learnHaikuWeights(rows, new Map([["SE|antiques|fixed", w]])).find((r) => r.bucket === "SE|antiques|fixed")!.haiku_weight;
    assert.equal(w, HAIKU_WEIGHT_MIN);
  });

  it("Haiku about as good as the others: the weight stays near the prior", () => {
    const row = learnHaikuWeights(Array.from({ length: 300 }, (_, i) => base(i, ALL_RIGHT, ALL_RIGHT))).find((r) => r.bucket === "SE|antiques|fixed")!;
    assert.ok(Math.abs(row.haiku_weight - HAIKU_LINK_WEIGHT) <= 0.0001);
    assert.equal(row.ratio, 1);
  });

  it("only unmodified valuations count (the Connector's own changes cannot bend its own weight); cancelled Haiku searches carry nothing", () => {
    const modified = Array.from({ length: 300 }, (_, i) => ({ ...base(i, ALL_RIGHT, HALF_RIGHT, "on"), searches: [psrch(ALL_RIGHT, { rule: "RH", executed_query: "b", is_haiku: true }), psrch(HALF_RIGHT)] }));
    assert.deepEqual(learnHaikuWeights(modified), []);
    const cancelled = Array.from({ length: 300 }, (_, i) => ({ ...base(i, ALL_RIGHT, HALF_RIGHT), searches: [psrch(ALL_RIGHT, { is_haiku: true, cancelled: true }), psrch(HALF_RIGHT)] }));
    assert.deepEqual(learnHaikuWeights(cancelled), []);
  });

  it("the others giving no price reference gives no scale: no row", () => {
    assert.deepEqual(learnHaikuWeights(Array.from({ length: 300 }, (_, i) => base(i, ALL_RIGHT, []))), []);
  });

  it("a search is never graded against itself: consistent but WRONG prices do not score as perfect (the old own-median flaw)", () => {
    // Haiku's three prices are all 300 (perfectly consistent with each other) but the market is 100. Graded against its own
    // median it would have scored 1.0; graded against the others it scores 0, so the weight must not rise.
    const rows = Array.from({ length: 300 }, (_, i) => base(i, [300, 300, 300], [100, 100, 100, 100, 100]));
    const row = learnHaikuWeights(rows).find((r) => r.bucket === "SE|antiques|fixed")!;
    assert.ok(row.ratio < 0.1, `ratio ${row.ratio}`);
    assert.ok(row.haiku_weight < HAIKU_LINK_WEIGHT);
  });

  it("older rows that only hold kept_sold counts are left out: a count and a price score are never mixed", () => {
    const legacy = Array.from({ length: 300 }, (_, i) => ({
      ...base(i, [], []), judge_ok: true,
      searches: [srch(null, false, 9, { is_haiku: true }), srch(null, false, 1), srch(null, false, 1)],
    }));
    assert.deepEqual(learnHaikuWeights(legacy), []);
  });
});

// ---------------------------------------------------------------- inside the Brain

const IDENT = { ...SAMPLE_IDENT, brand: "Orrefors", model: null, type: "orrefors vase", category: "antiques", google_queries: HAIKU };
const input = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };

function route(sent: string[]): Route {
  return async (call: Call, signal?: AbortSignal) => {
    if (call.url.includes("anthropic")) {
      const s = stepOf(call);
      if (s === "detail") return claudeReply(SAMPLE_DETAILS);
      if (s === "auth") return claudeReply(SAMPLE_AUTH);
      if (s === "ident") return claudeReply(IDENT);
      return streamJudge(sampleVerdict(), signal);
    }
    if (call.url.includes("serper")) {
      sent.push(String(call.body?.q));
      return serperSold(5, 60, String(sent.length), "www.tradera.com");
    }
    return json({}, 404);
  };
}

async function runWith(extra: Record<string, unknown> = {}, policy?: ReadonlyMap<string, number>) {
  const sent: string[] = [];
  const { deps } = makeDeps(route(sent));
  const out = await runBrain(input, testConfig({ connectorShare: 1, ...extra }), deps, {
    fx: getFxTable(deps, null), localPlan: searchAiDown, memory: null, connectorDraw: () => 0, connectorPolicy: policy ? () => policy : undefined,
  });
  return { out, sent };
}

describe("All four inside the Brain", () => {
  it("control group with all rules (share 0): Serper gets exactly the planned queries; every search is logged with its role and proposal", async () => {
    const control = await runWith({ connectorShare: 0, connectorRules: ["R1", "RG", "RH"] });
    assert.ok(control.sent.includes("orrefors orrefors vase site:tradera.com"), `sent: ${control.sent}`);
    assert.ok(control.sent.includes("orrefors vas tradera tradera slutpris"), "Haiku's query runs untouched");
    assert.ok(!control.sent.includes("orrefors vas tradera slutpris"), "the tidied Haiku query is NOT sent");
    const log = control.out.connectorLog!;
    assert.equal(log.applied, false);
    const roles = log.searches.map((s) => (s as Record<string, unknown>).role);
    assert.ok(roles.includes("haiku") && roles.includes("global") && roles.includes("local"));
    const rules = log.searches.map((s) => (s as Record<string, unknown>).rule).filter(Boolean);
    assert.ok(rules.includes("RG") && rules.includes("RH"), `the control group still logs the proposals of the new rules: ${rules}`);
    for (const s of log.searches) assert.equal(s.executed_query, s.original_query);
  });

  it("all rules treated: Serper gets the tidied global and Haiku queries; l_search_log keeps the ORIGINALS for the Python learner", async () => {
    const on = await runWith({ connectorRules: ["R1", "RG", "RH"] });
    assert.ok(on.sent.includes("Orrefors vase sold ebay") || on.sent.includes("orrefors vase sold ebay"), `sent: ${on.sent}`);
    assert.ok(on.sent.includes("orrefors vas tradera slutpris"), `sent: ${on.sent}`);
    const logged = on.out.searchLog.map((r) => r.query.toLowerCase());
    assert.ok(logged.includes("orrefors vas tradera tradera slutpris"), "Haiku's original query is what the Python learner sees");
    assert.ok(logged.includes("orrefors orrefors vase sold ebay"), "the global original is what the Python learner sees");
    assert.ok(!logged.includes("orrefors vas tradera slutpris"));
    // Both queries are logged, and the row says whether the Connector edited it (the Search AI skips edited rows).
    const executed = on.out.searchLog.map((r) => r.executed_query.toLowerCase());
    assert.ok(executed.includes("orrefors vas tradera slutpris"), "what really ran is logged too");
    const haikuRow = on.out.searchLog.find((r) => r.query.toLowerCase() === "orrefors vas tradera tradera slutpris")!;
    assert.equal(haikuRow.connector_modified, true);
    assert.equal(haikuRow.executed_query.toLowerCase(), "orrefors vas tradera slutpris");
    for (const r of on.out.searchLog) assert.equal(r.connector_modified, r.executed_query.toLowerCase() !== r.query.toLowerCase());
    assert.ok(on.out.searchLog.length <= 7);
    assert.equal(on.out.result.status, "ok");
  });

  it("only R1 listed: the global and Haiku searches are NOT touched", async () => {
    const off = await runWith({ connectorShare: 0 });
    const on = await runWith({ connectorRules: ["R1"] });
    assert.ok(on.sent.includes("orrefors vas tradera tradera slutpris"));
    assert.ok(!on.sent.includes("orrefors vas tradera slutpris"));
    assert.equal(off.sent.length, on.sent.length);
    const haikuRow = on.out.searchLog.find((r) => r.query.toLowerCase() === "orrefors vas tradera tradera slutpris")!;
    assert.equal(haikuRow.connector_modified, false, "RH is not listed: Haiku's search ran exactly as planned, so the Search AI may learn from it");
    assert.equal(haikuRow.executed_query, haikuRow.query);
  });

  it("the learned Haiku weight reaches the log: the Haiku search carries it, the others carry 1", async () => {
    const policy = new Map<string, number>([[weightKey("SE"), 1.45]]);
    const { out } = await runWith({}, policy);
    const weights = out.connectorLog!.searches.map((s) => [(s as Record<string, unknown>).is_haiku, (s as Record<string, unknown>).weight]);
    for (const [isHaiku, w] of weights) assert.equal(w, isHaiku ? 1.45 : 1);
    const none = await runWith();
    for (const s of none.out.connectorLog!.searches) assert.equal((s as Record<string, unknown>).weight, (s as Record<string, unknown>).is_haiku ? HAIKU_LINK_WEIGHT : 1);
  });

  it("the dial of RG and RH is read from the policy under their own keys", async () => {
    const policy = new Map<string, number>([["RH@SE|antiques|fixed", 0], ["RG@SE", 1]]);
    const sent: string[] = [];
    const { deps } = makeDeps(route(sent));
    const out = await runBrain(input, testConfig({ connectorShare: 0.5, connectorRules: ["R1", "RG", "RH"] }), deps, {
      fx: getFxTable(deps, null), localPlan: searchAiDown, memory: null, connectorDraw: () => 0.2, connectorPolicy: () => policy,
    });
    const byRule = (r: string) => out.connectorLog!.searches.find((s) => (s as Record<string, unknown>).rule === r) as Record<string, unknown>;
    assert.equal(byRule("RH").rule_dial, 0);
    assert.equal(byRule("RG").rule_dial, 1);
    assert.equal(byRule("RH").executed_query, byRule("RH").original_query, "RH dial 0 held it back");
    assert.notEqual(byRule("RG").executed_query, byRule("RG").original_query, "RG dial 1 let it through");
  });
});
