import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DIAL_MAX_STEP, MIN_N_PER_ARM, dialTarget, learnPolicy, rewardOf, stepToward, welchZ } from "../connector-learn.ts";
import type { LogRowForLearning } from "../connector-learn.ts";

const s = (kept: number, discarded = 0, weight = 1, over: object = {}) => ({ weight, kept_sold: kept, discarded, cancelled: false, failed: false, ...over });

/** A tiny deterministic wobble so the arms have a spread (no randomness in tests). */
const wobble = (i: number) => ((i * 7919) % 100) / 100 - 0.5;
function rows(n: number, applied: boolean, level: number, bucket = "SE|antiques|fixed"): LogRowForLearning[] {
  return Array.from({ length: n }, (_, i) => ({ mode: "on", applied, proposed_changes: 1, bucket, judge_ok: true, reward: level + wobble(i) }));
}

describe("Connector learner: reward", () => {
  it("Haiku's link counts three times when the weight given is 3; discarded hits cost; cancelled and failed searches carry no information", () => {
    assert.equal(rewardOf([s(2), s(2), s(2), s(2, 0, 3)]), 2);
    assert.equal(rewardOf([s(4, 4)]), 3); // 4 - 0.25 * 4
    assert.equal(rewardOf([s(1, 0, 1, { cancelled: true }), s(3)]), 3);
    assert.equal(rewardOf([s(1, 0, 1, { failed: true })]), null);
    assert.ok((rewardOf([s(0), s(0), s(0), s(4, 0, 3)]) as number) > (rewardOf([s(4), s(0), s(0), s(0, 0, 3)]) as number));
  });
});

describe("Connector learner: the dial", () => {
  it("dialTarget: a dial aims for 0 only when the rule is shown to hurt, otherwise 1 (never above the owner's share)", () => {
    assert.equal(dialTarget(-5, 2), 0);
    assert.equal(dialTarget(-2, 2), 0);
    assert.equal(dialTarget(-1.9, 2), 1, "below the bar it is luck, not proof");
    assert.equal(dialTarget(0, 2), 1);
    assert.equal(dialTarget(5, 2), 1);
  });
  it("one night moves a dial by at most DIAL_MAX_STEP", () => {
    assert.equal(stepToward(1, 0), 1 - DIAL_MAX_STEP);
    assert.equal(stepToward(0.1, 1), 0.1 + DIAL_MAX_STEP);
    assert.equal(stepToward(0.5, 0.55), 0.55);
  });
  it("too few valuations in an arm: nothing is learned", () => {
    assert.equal(welchZ({ n: MIN_N_PER_ARM - 1, mean: 3, variance: 1 }, { n: 100, mean: 1, variance: 1 }), null);
    assert.deepEqual(learnPolicy([...rows(MIN_N_PER_ARM - 1, true, 3), ...rows(100, false, 1)]), []);
    assert.deepEqual(learnPolicy([]), []);
  });
  it("R1 clearly helps: the dial stays at 1; R1 clearly hurts: it falls, but only a step per night", () => {
    const good = learnPolicy([...rows(60, true, 3), ...rows(60, false, 1)]);
    assert.equal(good.find((r) => r.bucket === "SE|antiques|fixed")!.dial, 1);
    const bad = learnPolicy([...rows(60, true, 1), ...rows(60, false, 3)]);
    const row = bad.find((r) => r.bucket === "SE|antiques|fixed")!;
    assert.equal(row.dial, 1 - DIAL_MAX_STEP);
    assert.ok(row.lift < 0 && row.z < 0);
    const next = learnPolicy([...rows(60, true, 1), ...rows(60, false, 3)], new Map([["SE|antiques|fixed", row.dial]]));
    assert.equal(next.find((r) => r.bucket === "SE|antiques|fixed")!.dial, 1 - 2 * DIAL_MAX_STEP);
  });
  it("writes the bucket and its parents (country|category, country)", () => {
    const t = learnPolicy([...rows(40, true, 2), ...rows(40, false, 2)]);
    assert.deepEqual(t.map((r) => r.bucket), ["SE", "SE|antiques", "SE|antiques|fixed"]);
    for (const r of t) assert.ok(r.dial >= 0 && r.dial <= 1);
  });
  it("shadow rows, rows without an answer from the Judge and rows with nothing proposed are ignored", () => {
    const junk: LogRowForLearning[] = [
      ...rows(60, true, 9).map((r) => ({ ...r, mode: "shadow" })),
      ...rows(60, false, 0).map((r) => ({ ...r, judge_ok: false })),
      ...rows(60, true, 9).map((r) => ({ ...r, proposed_changes: 0 })),
      ...rows(60, true, 9).map((r) => ({ ...r, reward: null })),
    ];
    assert.deepEqual(learnPolicy(junk), []);
  });
});
