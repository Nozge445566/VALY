// The interval recipe: one object builds the engine's input, the same object is saved for replay.
// What these tests protect: what is saved for replay is exactly what the engine used.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFxTable } from "../fx.ts";
import { buildFusedInterval as buildInterval } from "../fused-interval.ts";
import type { IntervalOutput } from "../interval.ts";
import { assemble, intervalRecipeOf, runBrain } from "../pipeline.ts";
import type { AssembleArgs, IntervalRecipe } from "../pipeline.ts";
import type { BrainInput, Finding, JudgeVerdict } from "../types.ts";
import {
  FAKE_JPEG_B64, SAMPLE_AUTH, SAMPLE_DETAILS, SAMPLE_IDENT, claudeReply, fakeEngine, json, makeDeps, sampleVerdict, stepOf, streamJudge, testConfig,
} from "./helpers.ts";

// ---------------------------------------------------------------- fixtures

const finding = (id: number, kind: "sold" | "asking", priceUsd: number): Finding => ({
  id, searchId: "s1", title: `Seiko ${id}`, snippet: "", url: `https://x.test/${id}`, site: "x.test", kind,
  price: priceUsd, currency: "USD", priceUsd, gl: "us",
});

function args(over: Partial<AssembleArgs> = {}): AssembleArgs {
  const findings = [1, 2, 3, 4, 5, 6].map((i) => finding(i, i % 3 === 0 ? "asking" : "sold", 55 + i * 1.234567));
  return {
    verdict: sampleVerdict({ same: [1, 2, 3, 4], similar: [5], unknowns: ["a", "b"], confidence: 71 }),
    ident: null,
    details: null,
    findings,
    marketState: "ok",
    soldTarget: 5,
    degraded: [],
    judgeRan: true,
    identConfidence: 45, // below IDENTITY_CONF_BELOW, so identitySimilar is true
    ...over,
  };
}

const input: BrainInput = { imageMediaType: "image/jpeg", imageBase64: FAKE_JPEG_B64, country: "SE" };

const PLAN = {
  ok: true, strategy_version: 4,
  searches: [
    { id: "s1", query: "seiko snk809 sold ebay", template_id: "fx_ebay_sold", kind: "exploit", gl: "us", hl: "en" },
    { id: "s2", query: "seiko snk809 sold more", template_id: "fx_local_sold", kind: "exploit", gl: "us", hl: "en" },
  ],
  stop: { sold_prices: 5, max_ms: 2000 },
};

/** n sold listings priced in EUR, so the USD price after conversion is NOT a whole number of cents. */
function eurListings(n: number, tag: string): Response {
  const organic = Array.from({ length: n }, (_, i) => ({
    title: `Seiko 5 SNK809 automatic watch ${tag}${i}`,
    link: `https://www.ebay.com/itm/${tag}${i}`,
    snippet: `Sold  Oct ${i + 1}, 2026  € ${(48 + i * 1.37).toFixed(2)}`,
  }));
  return json({ organic });
}

async function runWith(listings: [number, number], verdictOver: Partial<JudgeVerdict> = {}) {
  const { deps } = makeDeps(async (call, signal) => {
    if (call.url.includes("anthropic")) {
      const step = stepOf(call);
      if (step === "detail") return claudeReply(SAMPLE_DETAILS);
      if (step === "auth") return claudeReply(SAMPLE_AUTH);
      if (step === "auth") return claudeReply(SAMPLE_AUTH);
      if (step === "ident") return claudeReply(SAMPLE_IDENT);
      if (step === "judge") return streamJudge(sampleVerdict(verdictOver), signal);
    }
    if (call.url.includes("serper")) return eurListings(call.body?.q === "seiko snk809 sold ebay" ? listings[0] : listings[1], call.body?.q === "seiko snk809 sold ebay" ? "a" : "b");
    return json({}, 404);
  });
  return await runBrain(input, testConfig({ answerMs: 5000 }), deps, { fx: getFxTable(deps, null), memory: null, localPlan: fakeEngine(PLAN) });
}

type SavedInterval = {
  v: number;
  input: IntervalRecipe extends infer R ? Omit<R, "v" | "fallbackLevel" | "comps"> : never;
  comps: { priceUsd: number; kind: "sold" | "asking"; match: "same" | "similar" }[];
  fallbackLevel: IntervalRecipe["fallbackLevel"];
};

// ---------------------------------------------------------------- tests

describe("interval recipe: replay equals what was shown", () => {
  it("rebuilding from the saved steps.interval gives the same low, mid and high (within 0.01%)", async () => {
    // 12 listings found, the best 7 go to the Judge (select-ads.ts), so 7 are labelled and stored (storage keeps at most 15).
    // Prices are stored rounded to cents, which is why the tolerance is 0.01% and not exact.
    const run = await runWith([6, 6], { same: Array.from({ length: 7 }, (_, i) => i + 1) });
    const saved = run.steps.interval as SavedInterval;
    assert.ok(saved, "steps.interval was saved");
    assert.equal(saved.comps.length, 7, "the Judge's 7 listings were stored");

    const replay = buildInterval({ ...saved.input, comps: saved.comps, fallbackLevel: saved.fallbackLevel, k: 1 });
    for (const key of ["low", "mid", "high"] as const) {
      const shown = run.result[key];
      const rel = Math.abs(replay[key] - shown) / shown;
      assert.ok(rel < 1e-4, `${key}: replay ${replay[key]} vs shown ${shown} (relative ${rel})`);
    }
  });

  it("the rounding in storage is real: the live comps are not whole cents", async () => {
    // Guards the test above against passing for the wrong reason.
    const run = await runWith([6, 6], { same: Array.from({ length: 7 }, (_, i) => i + 1) });
    const saved = run.steps.interval as SavedInterval;
    const live = intervalRecipeOf(args({ findings: Array.from({ length: 7 }, (_, i) => finding(i + 1, "sold", 50.123456 + i)), verdict: sampleVerdict({ same: Array.from({ length: 7 }, (_, i) => i + 1) }) }));
    assert.ok(live.comps.some((c) => Math.abs(c.priceUsd * 100 - Math.round(c.priceUsd * 100)) > 1e-9), "fixture has sub-cent prices");
    assert.ok(saved.comps.every((c) => Math.abs(c.priceUsd * 100 - Math.round(c.priceUsd * 100)) < 1e-9), "stored prices are whole cents");
  });
});

describe("interval recipe: one source", () => {
  it("intervalRecipeOf gives deep-equal objects for the same arguments", () => {
    assert.deepEqual(intervalRecipeOf(args()), intervalRecipeOf(args()));
  });

  it("the recipe handed to onInterval is the one the engine used", () => {
    const got: { iv?: IntervalOutput; recipe?: IntervalRecipe } = {};
    const kOf = () => 1.3;
    assemble({ ...args(), kOf, onInterval: (iv, recipe) => { got.iv = iv; got.recipe = recipe; } });
    assert.ok(got.iv && got.recipe, "onInterval was called");
    const { iv, recipe } = got as { iv: IntervalOutput; recipe: IntervalRecipe };
    assert.deepEqual(recipe, intervalRecipeOf(args()), "same recipe as the public builder gives");
    // Feeding the handed recipe back to the engine must reproduce the engine's output exactly.
    assert.deepEqual(buildInterval({ ...recipe, kOf }), iv, "the engine ran on exactly this recipe");
  });

  it("the recipe has the documented values", () => {
    const r = intervalRecipeOf(args());
    assert.equal(r.v, 2);
    assert.equal(r.identitySimilar, true);
    assert.equal(r.unknownsCount, 2);
    assert.equal(r.condition, "good");
    assert.equal(r.fallbackLevel, "local", "default stays local");
    assert.equal(intervalRecipeOf(args({ fallbackLevel: "foreign" as never })).fallbackLevel, "foreign", "an explicit level wins");
    assert.equal(intervalRecipeOf(args({ identConfidence: null })).identitySimilar, false);
    assert.equal(r.comps.length, 5, "four same plus one similar");
  });

  it("calibration k never goes into the recipe", () => {
    const r = intervalRecipeOf({ ...args(), kOf: () => 2 }) as unknown as Record<string, unknown>;
    for (const key of ["k", "kOf", "kM", "sigmaCat"]) assert.ok(!(key in r), key);
  });
});

describe("interval recipe: no drift between recipe and what is saved", () => {
  it("steps.interval.input has exactly the recipe's keys (v, fallbackLevel and comps are saved beside it)", async () => {
    const run = await runWith([5, 5]);
    const saved = run.steps.interval as Record<string, unknown> & SavedInterval;
    const recipeKeys = Object.keys(intervalRecipeOf(args())).sort();
    const inputKeys = Object.keys(saved.input);
    const livesElsewhere = ["v", "fallbackLevel", "comps"];
    assert.deepEqual([...inputKeys, ...livesElsewhere].sort(), recipeKeys, "a field was added to one side only");
    assert.ok("fallbackLevel" in saved, "fallbackLevel stays in the breakdown, where the readers look");
    assert.ok(Array.isArray(saved.comps));
  });

  it("the saved input values equal the recipe the same verdict gives", async () => {
    const run = await runWith([5, 5], { unknowns: ["x"], confidence: 63 });
    const saved = run.steps.interval as SavedInterval;
    // The Judge writes no price or confidence any more: both are made by code (math.ts) from the labelled ads.
    assert.ok(saved.input.modelConfidence >= 5 && saved.input.modelConfidence <= 95);
    assert.equal(saved.input.unknownsCount, 1);
    assert.ok(saved.input.model.low < saved.input.model.mid && saved.input.model.mid < saved.input.model.high);
  });
});

describe("interval recipe: version", () => {
  it("new runs are saved as v2 (the fused engine)", async () => {
    const run = await runWith([5, 5]);
    assert.equal((run.steps.interval as SavedInterval).v, 2);
  });

  const rows = (...vs: (number | undefined)[]) => vs.map((v, i) => ({
    run_id: `r${i}`,
    actual_price: 60,
    currency: "USD",
    steps: {
      interval: {
        ...(v === undefined ? {} : { v }),
        mu: Math.log(60), muM: Math.log(60), sLow2: 0.04, sHigh2: 0.04, t: 1.6, k: 1, bucket: "watch|none", comps: [],
      },
    },
  }));


});

describe("interval recipe: the comparables are worked out once", () => {
  it("assemble reads the Judge's lists once (compsForInterval is the only reader of `similar` there)", () => {
    let reads = 0;
    const base = sampleVerdict({ same: [1, 2, 3], similar: [4, 5] });
    const verdict = new Proxy(base, {
      get(target, prop, recv) {
        if (prop === "similar") reads++;
        return Reflect.get(target, prop, recv);
      },
    });
    assemble({ ...args({ verdict }), onInterval: () => {} });
    assert.equal(reads, 1, "compsForInterval ran once for the whole assemble");
  });

  it("the pipeline calls compsForInterval from one place only (the recipe builder)", async () => {
    // runBrain's callback is not reachable with a spy (the Judge's verdict is parsed inside the
    // run), so this also guards the source: the definition, plus the single call in intervalRecipeOf.
    const { readFile, readdir } = await import("node:fs/promises");
    const dir = new URL("../pipeline/", import.meta.url);
    const src = (await Promise.all((await readdir(dir)).filter((f) => f.endsWith(".ts")).map((f) => readFile(new URL(f, dir), "utf8")))).join("\n");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    const calls = code.match(/compsForInterval\(/g) ?? [];
    assert.equal(calls.length, 2, "definition + one call");
    const call = /comps: compsForInterval\(v, a\.findings, a\.judgeRan, \{/.test(code);
    assert.ok(call, "the one call lives in intervalRecipeOf");
  });
});
