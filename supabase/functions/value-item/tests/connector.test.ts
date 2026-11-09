import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyConnector, bucketChain, connectorBucket, dialFor, localNameFrom, planKeepsRules, proposeR1 } from "../connector.ts";
import type { ConnectorContext } from "../connector.ts";
import { loadConfig } from "../config.ts";
import { fixedPlan } from "../fixed-templates.ts";
import { runBrain } from "../pipeline.ts";
import { getFxTable } from "../fx.ts";
import { handleRequest } from "../handler.ts";
import { DEFAULT_LIMITS } from "../protection.ts";
import { validateSearchPlan } from "../validate.ts";
import type { Fingerprint, SearchPlan } from "../types.ts";
import {
  FAKE_DATA_URL, FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, fakeStore, json, makeDeps, sampleVerdict, serperSold, stepOf, streamJudge, testConfig,
} from "./helpers.ts";
import type { Call, Route } from "./helpers.ts";

/** The Search AI engine is down: the fixed templates plan the searches (same as before, now without a network). */
const searchAiDown = fakeEngine(() => { throw new Error("search ai is down"); });

const FP: Fingerprint = { category: "antiques", brand: "Orrefors", type: "vase", model: null, era: null, country: "SE", language: "sv" };
const HAIKU = ["orrefors vas såld slutpris"];

const ctx = (over: Partial<ConnectorContext> = {}): ConnectorContext => ({
  fingerprint: FP, haikuQueries: HAIKU, share: 1, minShare: 0.05, draw: 0, dial: null, ...over,
});
const plan = (fp = FP, q = HAIKU) => fixedPlan(fp, q);

/** The plan as validateSearchPlan wants to read it (the JSON the Search AI sends). */
function asRaw(p: SearchPlan) {
  return { ok: true, strategy_version: 1, searches: p.searches, stop: { sold_prices: p.stop.soldPrices, max_ms: p.stop.maxMs } };
}

describe("Connector: settings", () => {
  it("the Connector is always on: no mode switch, all three rules, default share", () => {
    const cfg = loadConfig((k) => ({ ANTHROPIC_API_KEY: "x", CONNECTOR_MODE: "off", CONNECTOR_RULES: "R1" } as Record<string, string>)[k]);
    assert.equal("connectorMode" in cfg, false, "CONNECTOR_MODE is not read");
    assert.deepEqual(cfg.connectorRules, ["R1", "RG", "RH"]);
    assert.equal(cfg.connectorShare, 0.5);
  });
});

describe("Connector: rule R1", () => {
  it("changes a local search of an item without a model, and keeps site: and the plan legal", () => {
    const p = plan();
    const out = applyConnector(p, ctx());
    assert.equal(out.record!.applied, true);
    const site = out.plan.searches.find((s) => s.template_id === "fx_local_site")!;
    assert.equal(site.query, "Orrefors vas site:tradera.com");
    assert.ok(planKeepsRules(p, out.plan));
    assert.equal(validateSearchPlan(asRaw(out.plan)).ok, true);
  });

  it("never touches global searches or Haiku's own search; never more or fewer searches; identity fields unchanged", () => {
    const p = plan();
    const out = applyConnector(p, ctx());
    assert.equal(out.plan.searches.length, p.searches.length);
    p.searches.forEach((s, i) => {
      const n = out.plan.searches[i];
      assert.deepEqual([n.id, n.kind, n.template_id, n.gl, n.hl], [s.id, s.kind, s.template_id, s.gl, s.hl]);
      if (s.gl === "us" || s.template_id.startsWith("id_fixed")) assert.equal(n.query, s.query);
    });
    const lower = out.plan.searches.map((s) => s.query.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, "no duplicates");
    for (const s of out.plan.searches) assert.ok(s.query.length >= 3 && s.query.length <= 120);
  });

  it("does not make a copy of Haiku's own query (that search would be wasted)", () => {
    const out = applyConnector(plan(), ctx());
    const local = out.plan.searches.find((s) => s.template_id === "fx_local_sold")!;
    assert.equal(local.query, "Orrefors vase såld slutpris", "would equal Haiku's query, so it stays");
  });

  it("works for Search AI plans (template ids starting with id:) and leaves Haiku's candidate alone", () => {
    const p: SearchPlan = {
      strategyVersion: 3, source: "search_ai", stop: { soldPrices: 5, maxMs: 2000 },
      searches: [
        { id: "s1", query: "Orrefors vase sold tradera", template_id: "mut:site:tradera.com", kind: "exploit", gl: "se", hl: "sv" },
        { id: "s2", query: "orrefors vas såld slutpris", template_id: "id:loc:sold:web", kind: "exploit", gl: "se", hl: "sv" },
      ],
    };
    const out = applyConnector(p, ctx());
    assert.equal(out.plan.searches[0].query, "Orrefors vas sold tradera");
    assert.equal(out.plan.searches[1].query, "orrefors vas såld slutpris");
    assert.equal(out.record!.source, "search_ai");
  });

  it("handles Swedish letters å ä ö", () => {
    const fp = { ...FP, brand: "Gustavsberg", type: "bowl" };
    const out = applyConnector(plan(fp, ["gustavsberg skål såld slutpris"]), ctx({ fingerprint: fp, haikuQueries: ["gustavsberg skål såld slutpris"] }));
    assert.equal(out.record!.local_name, "skål");
    assert.ok(out.plan.searches.some((s) => s.query === "Gustavsberg skål site:tradera.com"));
  });

  it("the control group: the plan stays untouched when the draw is above the share, and it is recorded", () => {
    const p = plan();
    const out = applyConnector(p, ctx({ share: 0.5, draw: 0.9 }));
    assert.equal(out.plan, p);
    assert.equal(out.record!.applied, false);
    assert.equal(out.record!.control, true);
    assert.equal(out.record!.draw, 0.9);
    assert.equal(applyConnector(p, ctx({ share: 0.5, draw: 0.2 })).record!.applied, true);
  });

  it("the learned dial lowers the share but never below the floor, and never raises it above the share", () => {
    const p = plan();
    const low = applyConnector(p, ctx({ share: 0.5, dial: 0, draw: 0.1 }));
    assert.equal(low.record!.effective_share, 0.05);
    assert.equal(low.record!.applied, false);
    assert.equal(low.record!.held_back, true);
    assert.equal(applyConnector(p, ctx({ share: 0.5, dial: 0, draw: 0.04 })).record!.applied, true, "the floor keeps learning alive");
    assert.equal(applyConnector(p, ctx({ share: 0.5, dial: 1, draw: 0.6 })).record!.applied, false, "never above the share");
    assert.equal(applyConnector(p, ctx({ share: 0.4, dial: 0.5, draw: 0.19 })).record!.applied, true);
    assert.equal(applyConnector(p, ctx({ share: 0.4, dial: 0.5, draw: 0.21 })).record!.applied, false);
  });
});

describe("Connector: R1 does nothing", () => {
  const quiet = (fp: Fingerprint, queries: string[], planArg?: SearchPlan) => {
    const p = planArg ?? plan(fp, queries);
    const out = applyConnector(p, ctx({ fingerprint: fp, haikuQueries: queries }));
    assert.equal(out.plan, p);
    assert.equal(out.record!.proposed_changes, 0);
    assert.equal(out.record!.applied, false);
    return out.record!;
  };

  it("with a model (brand + model is language-neutral)", () => {
    quiet({ ...FP, model: "Ariel" }, ["orrefors ariel vas såld slutpris"]);
  });
  it("with an unknown country", () => {
    quiet({ ...FP, country: "ZZ" }, HAIKU);
  });
  it("with an English-language market", () => {
    quiet({ ...FP, country: "GB", language: "en" }, ["orrefors vase sold"]);
  });
  it("with no Haiku query", () => {
    quiet(FP, [], plan(FP, []));
  });
  it("when Haiku's query is not in the plan (the plan only has template searches)", () => {
    const r = applyConnector(plan(FP, []), ctx()).record!;
    assert.equal(r.proposed_changes >= 1, true, "the local name still comes from ident.google_queries, as the document says");
  });
  it("when the extracted local name equals the English type", () => {
    quiet(FP, ["orrefors vase såld slutpris"]);
  });
  it("when the name contains digits or operators", () => {
    assert.equal(localNameFrom("orrefors vas 1950 såld slutpris", FP), null);
    assert.equal(localNameFrom("orrefors vas -ebay såld slutpris", FP), null);
    assert.equal(localNameFrom("orrefors vas OR skål såld slutpris", FP), null);
    assert.equal(localNameFrom("orrefors vas (kristall) såld", FP), null);
    quiet(FP, ["orrefors vas 1950 såld slutpris"]);
  });
  it("for languages written without spaces", () => {
    const fp = { ...FP, country: "JP", language: "ja", brand: "Seiko" };
    quiet(fp, ["セイコー 時計 落札"]);
  });
  it("for a language the sold-word tables do not know", () => {
    quiet({ ...FP, country: "IN", language: "hi" }, ["orrefors vas bika"]);
  });
  it("when the name has more than four words or is empty", () => {
    assert.equal(localNameFrom("orrefors en stor gammal blå glas vas såld", FP), null);
    assert.equal(localNameFrom("orrefors såld slutpris site:tradera.com", FP), null);
  });
  it("when the name is already inside the template query", () => {
    const p: SearchPlan = { strategyVersion: null, source: "fixed", stop: { soldPrices: 5, maxMs: 2000 },
      searches: [{ id: "s1", query: "Orrefors vase vas site:tradera.com", template_id: "fx_local_site", kind: "fixed", gl: "se", hl: "sv" }] };
    const r = quiet(FP, HAIKU, p);
    assert.equal(r.searches[0].skipped, "name_already_present");
  });
  it("never touches a quoted query", () => {
    const p: SearchPlan = { strategyVersion: null, source: "fixed", stop: { soldPrices: 5, maxMs: 2000 },
      searches: [{ id: "s1", query: "\"Orrefors vase\" såld slutpris", template_id: "fx_x", kind: "fixed", gl: "se", hl: "sv" }] };
    quiet(FP, HAIKU, p);
  });
  it("strips marketplace names and the site: part when finding the name", () => {
    assert.equal(localNameFrom("orrefors vas tradera såld slutpris site:tradera.com \"vas\"", FP), "vas vas");
    assert.equal(localNameFrom("orrefors \"vas\" tradera såld slutpris site:tradera.com", FP), "vas");
  });
});

describe("Connector: safety", () => {
  it("an error inside the Connector returns the original plan", () => {
    const p = plan();
    const bad = { ...ctx(), fingerprint: null as unknown as Fingerprint };
    const out = applyConnector(p, bad);
    assert.equal(out.plan, p);
    assert.equal(out.record, null);
  });
  it("a broken draw falls on the safe side (control)", () => {
    const out = applyConnector(plan(), ctx({ share: 0.5, draw: Number.NaN }));
    assert.equal(out.record!.applied, false);
  });
  it("planKeepsRules refuses any change of identity, count, length or duplicates", () => {
    const p = plan();
    const mut = (f: (s: SearchPlan) => void) => { const c: SearchPlan = JSON.parse(JSON.stringify(p)); c.stop = p.stop; f(c); return planKeepsRules(p, c); };
    assert.equal(mut(() => undefined), true, "an identical copy keeps every rule");
    assert.equal(mut((c) => c.searches.pop()), false);
    assert.equal(mut((c) => { c.searches[0].gl = "se"; }), false);
    assert.equal(mut((c) => { c.searches[0].template_id = "other"; }), false);
    assert.equal(mut((c) => { c.searches[0].query = "ab"; }), false);
    assert.equal(mut((c) => { c.searches[0].query = "x".repeat(121); }), false);
    assert.equal(mut((c) => { c.searches[1].query = c.searches[0].query.toUpperCase(); }), false);
  });
  it("buckets and the dial lookup follow the parent chain", () => {
    const b = connectorBucket(FP, "fixed");
    assert.equal(b, "SE|antiques|fixed");
    assert.deepEqual(bucketChain(b), ["SE|antiques|fixed", "SE|antiques", "SE"]);
    assert.equal(dialFor(new Map([["SE", 0.3]]), b), 0.3);
    assert.equal(dialFor(new Map([["SE", 0.3], ["SE|antiques", 0.8]]), b), 0.8);
    assert.equal(dialFor(new Map(), b), null);
    assert.equal(dialFor(undefined, b), null);
  });
  it("proposeR1 never changes the order or count", () => {
    const p = plan();
    const r = proposeR1(p, FP, HAIKU);
    assert.deepEqual(r.searches.map((s) => s.id), p.searches.map((s) => s.id));
  });
});

// ---------------------------------------------------------------- inside the pipeline and the handler

const IDENT = { ...SAMPLE_IDENT, brand: "Orrefors", model: null, type: "vase", category: "antiques", google_queries: HAIKU };
const input = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };

function route(serperQueries: string[]): Route {
  return async (call: Call, signal?: AbortSignal) => {
    if (call.url.includes("anthropic")) {
      const s = stepOf(call);
      if (s === "detail") return claudeReply(SAMPLE_DETAILS);
      if (s === "auth") return claudeReply(SAMPLE_AUTH);
      if (s === "ident") return claudeReply(IDENT);
      return streamJudge(sampleVerdict(), signal);
    }
    if (call.url.includes("serper")) {
      serperQueries.push(String(call.body?.q));
      return serperSold(5, 60, String(serperQueries.length), "www.tradera.com");
    }
    return json({}, 404);
  };
}

async function runWith(extra: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const { deps } = makeDeps(route(sent));
  const out = await runBrain(input, testConfig({ connectorShare: 1, ...extra }), deps, {
    fx: getFxTable(deps, null), localPlan: searchAiDown, memory: null, connectorDraw: () => 0,
  });
  return { out, sent };
}

describe("Connector inside the Brain", () => {
  it("control group (share 0): Serper gets exactly the planned queries; the proposal is logged, nothing is applied", async () => {
    const control = await runWith({ connectorShare: 0 });
    assert.ok(control.sent.includes("orrefors vase site:tradera.com"));
    const log = control.out.connectorLog!;
    assert.equal(log.mode, "on");
    assert.equal(log.applied, false);
    assert.equal(log.control, true);
    assert.ok(log.proposed_changes >= 1);
    assert.equal(log.fingerprint.country, "SE");
    assert.equal("image" in (log as object), false, "fingerprint only: no photo");
  });

  it("treated: the changed query is what goes to Serper, but l_search_log keeps the ORIGINAL query and template", async () => {
    const on = await runWith();
    assert.ok(on.sent.includes("orrefors vas site:tradera.com"));
    assert.ok(!on.sent.includes("orrefors vase site:tradera.com"));
    const logged = on.out.searchLog.map((r) => r.query);
    assert.ok(logged.includes("orrefors vase site:tradera.com"), "the original query is logged for the Python learner");
    assert.ok(!logged.includes("orrefors vas site:tradera.com"));
    const row = on.out.connectorLog!.searches.find((s) => s.template_id === "fx_local_site") as Record<string, unknown>;
    assert.equal(row.original_query, "orrefors vase site:tradera.com");
    assert.equal(row.executed_query, "orrefors vas site:tradera.com");
    assert.equal(on.out.connectorLog!.applied, true);
    assert.equal(on.out.connectorLog!.judge_ok, true);
    assert.equal(typeof on.out.connectorLog!.reward, "number");
    assert.ok(on.out.searchLog.length <= 7);
    assert.equal(on.out.result.status, "ok");
  });

  it("a control valuation (draw above the share) runs the original queries and is recorded as control", async () => {
    const sent: string[] = [];
    const { deps } = makeDeps(route(sent));
    const out = await runBrain(input, testConfig({ connectorShare: 0.5 }), deps, { fx: getFxTable(deps, null), localPlan: searchAiDown, memory: null, connectorDraw: () => 0.9 });
    assert.ok(sent.includes("orrefors vase site:tradera.com"));
    assert.equal(out.connectorLog!.control, true);
    assert.equal(out.connectorLog!.applied, false);
    assert.equal(out.connectorLog!.draw, 0.9);
  });

  it("the learned dial from the policy table is used", async () => {
    const sent: string[] = [];
    const { deps } = makeDeps(route(sent));
    const out = await runBrain(input, testConfig({ connectorShare: 0.5 }), deps, {
      fx: getFxTable(deps, null), localPlan: searchAiDown, memory: null, connectorDraw: () => 0.2, connectorPolicy: () => new Map([["SE", 0]]),
    });
    assert.equal(out.connectorLog!.dial, 0);
    assert.equal(out.connectorLog!.applied, false);
    assert.equal(out.connectorLog!.held_back, true);
  });
});

describe("Connector in the handler: logging never blocks or breaks the answer", () => {
  const request = () => new Request("https://x.test/functions/v1/value-item", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: FAKE_DATA_URL, deviceId: "device-0123456789abcdef", country: "SE" }),
  });

  it("writes the connector row after the answer, with the run id", async () => {
    const store = fakeStore();
    const { deps } = makeDeps(route([]));
    const bg: Promise<unknown>[] = [];
    const res = await handleRequest(request(), { getConfig: () => testConfig(), store, deps, limits: DEFAULT_LIMITS, background: (p) => { bg.push(p); }, localPlan: searchAiDown });
    await Promise.all(bg);
    assert.equal(res.status, 200);
    const body = await res.json() as { runId: string };
    assert.equal(store.connectorLogged.length, 1);
    assert.equal(store.connectorLogged[0].run_id, body.runId);
  });

  it("a failing log write (table missing) is swallowed: the answer is still 200", async () => {
    const store = fakeStore();
    store.connectorLogFails = true;
    const { deps } = makeDeps(route([]));
    const bg: Promise<unknown>[] = [];
    const res = await handleRequest(request(), { getConfig: () => testConfig(), store, deps, limits: DEFAULT_LIMITS, background: (p) => { bg.push(p); }, localPlan: searchAiDown });
    await Promise.all(bg);
    assert.equal(res.status, 200);
  });

  it("loads the dial table without waiting for it", async () => {
    const store = fakeStore();
    store.connectorPolicy = [{ bucket: "SE", dial: 0.5 }];
    const { deps } = makeDeps(route([]));
    const bg: Promise<unknown>[] = [];
    const res = await handleRequest(request(), { getConfig: () => testConfig(), store, deps, limits: DEFAULT_LIMITS, background: (p) => { bg.push(p); }, localPlan: searchAiDown });
    await Promise.all(bg);
    assert.equal(res.status, 200);
    assert.equal(store.connectorPolicyCalls, 1);
  });
});
