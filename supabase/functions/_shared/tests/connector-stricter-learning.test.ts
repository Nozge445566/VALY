// The three honest-learning fixes (3 Nov 2026):
//   1. each rule is scored ONLY on the searches it edits (no dilution by searches it never touches)
//   2. a dial only goes down on proof of harm, corrected for the number of tests (no chasing luck)
//   3. the Search AI is never credited with the results of a query the Connector edited
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DIAL_MAX_STEP, FAMILY_ALPHA, MIN_N_PER_ARM, learnPolicy, normalQuantile, rewardWithHaikuWeight, welchZ, zNeeded,
} from "../connector-learn.ts";
import type { LearnSearch, LogRowForLearning } from "../connector-learn.ts";
import { prepare, rewardParts, train, usable } from "../search-ai/learner.ts";
import { insertSearchLog } from "../../value-item/search-log-insert.ts";
import type { SearchLogRow } from "../../value-item/types.ts";

/** Deterministic pseudo-random numbers 0..1 (no real randomness in tests). */
function lcg(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

describe("the normal quantile and the multiple-test threshold", () => {
  it("matches the known values", () => {
    const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} vs ${b}`);
    close(normalQuantile(0.5), 0);
    close(normalQuantile(0.9), 1.281552);
    close(normalQuantile(0.95), 1.644854);
    close(normalQuantile(0.975), 1.959964);
    close(normalQuantile(0.999), 3.090232);
    close(normalQuantile(0.01), -2.326348);
  });
  it("one test needs the plain one-sided bar; more tests need a higher bar", () => {
    assert.equal(FAMILY_ALPHA, 0.05);
    assert.ok(Math.abs(zNeeded(1) - 1.644854) < 1e-5);
    assert.ok(zNeeded(10) > zNeeded(5) && zNeeded(5) > zNeeded(1));
    assert.ok(zNeeded(100) > 3.2);
    assert.equal(zNeeded(0), zNeeded(1), "no tests: no crash");
  });
});

// ---------------------------------------------------------------- 1. own searches only

const price = (usd: number[], over: Partial<LearnSearch> = {}): LearnSearch => ({
  rule: null, original_query: "a", executed_query: "a", is_haiku: false, kept_sold: 0, discarded: 0, prices: usd, latency_ms: 1000, cancelled: false, failed: false, ...over,
});

describe("a rule is scored only on the searches it edits", () => {
  it("the other searches of the valuation only supply the market median", () => {
    const mine = price([100, 100], { rule: "R1" });
    const other = price([100, 100]);
    const wild = price([5, 900]);
    const all = [mine, other, wild];
    const own = rewardWithHaikuWeight(all, [mine], 1.375) as number;
    const whole = rewardWithHaikuWeight(all, all, 1.375) as number;
    assert.ok(own > whole, "the wild search drags the whole valuation down, but it is not the rule's search");
    // the same own search scored alone against the same pool does not change when a search it never touches changes its prices
    const wild2 = price([6, 1000]);
    assert.equal(rewardWithHaikuWeight([mine, other, wild2], [mine], 1.375), rewardWithHaikuWeight([mine, other, wild2], [mine], 1.375));
  });

  it("if none of the rule's searches answered there is nothing to score", () => {
    const mine = price([100], { rule: "R1", failed: true });
    assert.equal(rewardWithHaikuWeight([mine, price([100, 100])], [mine], 1.375), null);
  });

  it("a real harm on the edited search is found even when the other searches are very noisy (the old whole-valuation score hid it)", () => {
    const rnd = lcg(7);
    const rows: LogRowForLearning[] = [];
    for (let i = 0; i < 120; i++) {
      const treated = i % 2 === 0;
      // R1's search finds the market price (100) when untouched, but a wrong one (150) when edited: a true HARM of the edit
      const mine = price(treated ? [150, 150] : [100, 100], { rule: "R1", rule_on: true, executed_query: treated ? "b" : "a" });
      // the other three searches find 0, 1 or 2 prices around the market price: big swings in THEIR score, nothing to do with the rule
      const noisy = () => price(Array.from({ length: Math.floor(rnd() * 3) }, () => 100 * (0.6 + 0.8 * rnd())));
      rows.push({ mode: "on", applied: treated, proposed_changes: 1, bucket: "SE|watch|fixed", judge_ok: true, reward: null, searches: [mine, noisy(), noisy(), noisy()] });
    }
    const t = learnPolicy(rows);
    const own = t.find((r) => r.bucket === "SE|watch|fixed")!;
    assert.ok(own.z <= -zNeeded(t.length), `the harm must be visible: z=${own.z}, bar=${-zNeeded(t.length)}`);
    assert.equal(own.dial, 1 - DIAL_MAX_STEP);
    // the same data scored the OLD way (the whole valuation) drowns in the noise of the three untouched searches
    const arm = (flag: boolean) => {
      const xs = rows.filter((r) => r.applied === flag).map((r) => rewardWithHaikuWeight(r.searches!, r.searches!, 1.375) as number);
      const mean = xs.reduce((x, y) => x + y, 0) / xs.length;
      return { n: xs.length, mean, variance: xs.reduce((x, y) => x + (y - mean) ** 2, 0) / (xs.length - 1) };
    };
    const whole = welchZ(arm(true), arm(false))!;
    assert.ok(Math.abs(whole.z) < Math.abs(own.z), `whole-valuation z=${whole.z} is weaker than own-search z=${own.z}`);
  });
});

// ---------------------------------------------------------------- 2. no chasing luck

describe("a dial moves only on proof of harm, corrected for the number of tests", () => {
  /** `buckets` countries where the rule truly does NOTHING: treated and control come from the same distribution. */
  function nothingHappens(buckets: number, perArm: number, seed: number): LogRowForLearning[] {
    const rnd = lcg(seed);
    const rows: LogRowForLearning[] = [];
    for (let b = 0; b < buckets; b++) {
      for (let i = 0; i < perArm * 2; i++) {
        const treated = i % 2 === 0;
        rows.push({
          mode: "on", applied: treated, proposed_changes: 1, bucket: `C${String(b).padStart(3, "0")}|watch|fixed`, judge_ok: true, reward: 1 + rnd(),
        });
      }
    }
    return rows;
  }

  it("100 buckets where nothing is going on: no dial moves (the old 90 percent test without correction would have braked several)", () => {
    const rows = nothingHappens(100, MIN_N_PER_ARM, 12345);
    const table = learnPolicy(rows);
    assert.ok(table.length >= 100, "all buckets were tested");
    assert.ok(table.every((r) => r.dial === 1), "luck moved a dial");
    // prove the test is meaningful: with the old, uncorrected 90 percent bar, luck WOULD have found "harm" in some of these
    const old = table.filter((r) => r.z <= -1.28).length;
    assert.ok(old >= 3, `the uncorrected bar should have fired by luck here, it fired ${old} times`);
  });

  it("a real, large harm is still found even with many tests", () => {
    const rows = nothingHappens(30, MIN_N_PER_ARM, 99).map((r) => (r.bucket.startsWith("C007") && r.applied ? { ...r, reward: (r.reward as number) - 1 } : r));
    const table = learnPolicy(rows);
    assert.equal(table.find((r) => r.bucket === "C007|watch|fixed")!.dial, 1 - DIAL_MAX_STEP);
    assert.ok(table.filter((r) => r.dial < 1).every((r) => r.bucket.startsWith("C007")));
  });

  it("a dial that was lowered earlier relaxes back toward 1 when the proof is gone", () => {
    const rows = nothingHappens(1, 40, 5);
    const t = learnPolicy(rows, new Map([["C000|watch|fixed", 0.5]]));
    assert.equal(t.find((r) => r.bucket === "C000|watch|fixed")!.dial, 0.5 + DIAL_MAX_STEP);
  });

  it("a rule that clearly HELPS is left at 1 (the dial never rewards a rule with more than the owner's share)", () => {
    const rows = nothingHappens(1, 60, 5).map((r) => (r.applied ? { ...r, reward: (r.reward as number) + 2 } : r));
    assert.ok(learnPolicy(rows).every((r) => r.dial === 1));
  });

  it("Welch still refuses small arms", () => {
    assert.equal(welchZ({ n: MIN_N_PER_ARM - 1, mean: 1, variance: 1 }, { n: 99, mean: 0, variance: 1 }), null);
  });
});

// ---------------------------------------------------------------- 3. the Search AI and edited queries

const row = (over: Record<string, unknown> = {}) => ({
  created_at: "2026-11-02T10:00:00+00:00",
  fingerprint: { category: "watch", brand: "Seiko", type: "watch", model: null, era: null, country: "SE", language: "sv" },
  template_id: "fx_local_sold",
  query: "Seiko watch sold",
  gl: "se", hl: "sv", site: null, kept_sold: 0, sold_count: 2, latency_ms: 1000, cancelled: false,
  prices: [{ usd: 100, kind: "sold", verdict: "same" }, { usd: 100, kind: "sold", verdict: "same" }],
  ...over,
});

describe("the Search AI never credits a template with the results of an edited query", () => {
  it("a row marked connector_modified is not usable; old rows without the field are", () => {
    assert.equal(usable(row()), true);
    assert.equal(usable(row({ connector_modified: false })), true);
    assert.equal(usable(row({ connector_modified: true, executed_query: "Seiko klocka sold" })), false);
  });

  it("training leaves the edited row out of the template's arm, but its prices still help the market median", () => {
    const plain = row();
    const edited = row({ connector_modified: true, executed_query: "Seiko klocka sold", prices: [{ usd: 400, kind: "sold", verdict: "same" }, { usd: 400, kind: "sold", verdict: "same" }] });
    const rows = [plain, edited];
    prepare(rows);
    // the pooled median of this valuation is (100,100,400,400) -> 250; the plain row's own prices (100) are off it
    const [scoreWith] = rewardParts(plain);
    const aloneRows = [row({ created_at: "2026-11-02T11:00:00+00:00" })];
    prepare(aloneRows);
    const [scoreAlone] = rewardParts(aloneRows[0]);
    assert.ok(scoreWith < scoreAlone, "the edited row's prices are part of the market reference");
    const policy = train([plain, edited], new Date("2026-11-02T12:00:00Z"));
    assert.equal(policy.training.rows, 1, "only the unedited row trains the Search AI");
    const arm = [...policy.arms.values()][0].get("fx_local_sold")!;
    assert.equal(arm[2], 1, "the template was observed once, not twice");
  });
});

describe("what is written to l_search_log", () => {
  const logRow = (over: Partial<SearchLogRow> = {}): SearchLogRow => ({
    strategy_version: 1, source: "fixed", fingerprint: row().fingerprint as never, query: "a b", executed_query: "a b", connector_modified: false,
    template_id: "t", kind: "web" as never, gl: "us", hl: "en", site: null, result_count: 1, sold_count: 1, kept_sold: 0, kept_asking: 0, discarded: 0,
    prices: [], own_sold: null, latency_ms: 10, cost_usd: 0, cancelled: false, stop_reason: "done" as never, judge_ok: false, ...over,
  });
  const fakeDb = (failFirst: string | null) => {
    const calls: unknown[][] = [];
    return {
      calls,
      db: {
        from: () => ({
          insert: (rows: unknown) => {
            calls.push(rows as unknown[]);
            const err = calls.length === 1 && failFirst ? { message: failFirst } : null;
            return Promise.resolve({ error: err });
          },
        }),
      },
    };
  };

  it("normal case: all rows, both queries, one insert", async () => {
    const f = fakeDb(null);
    await insertSearchLog(f.db, [logRow(), logRow({ connector_modified: true, executed_query: "a c" })]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].length, 2);
  });

  it("the database does not have the new columns yet: edited rows are dropped, the others are written the old way", async () => {
    const f = fakeDb('Could not find the \'executed_query\' column of \'l_search_log\' in the schema cache');
    await insertSearchLog(f.db, [logRow(), logRow({ connector_modified: true, executed_query: "a c" })]);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].length, 1);
    assert.ok(!("executed_query" in (f.calls[1][0] as object)) && !("connector_modified" in (f.calls[1][0] as object)));
  });

  it("any other database error is still an error", async () => {
    const f = fakeDb("permission denied");
    await assert.rejects(() => insertSearchLog(f.db, [logRow()]), /permission denied/);
  });

  it("no rows: no call", async () => {
    const f = fakeDb(null);
    await insertSearchLog(f.db, []);
    assert.equal(f.calls.length, 0);
  });
});
