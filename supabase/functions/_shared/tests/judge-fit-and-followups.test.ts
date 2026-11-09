import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fitCalibration, isOscillating } from "../calibration-fit.ts";
import { applyAdCalibration, fitJudgeBands, resetAdCalibration, MIN_BAND_N } from "../judge-fit.ts";
import { P_SAME_SE2, RELATIVE_BANDS, RELATIVE_FACTOR } from "../../value-item/ad-calibration.ts";
import { rng, simulate } from "../../value-item/backtest.ts";
const B = "electronics|strong|local";
const recs = (n: number, seed: number) => simulate({ runs: n, seed }).map((r) => ({ ...r, bucket: B }));
const kOf = (rows: { bucket: string; k: number }[]) => rows.find((r) => r.bucket === B)!.k;

afterEach(() => resetAdCalibration());

describe("calibration follow-ups", () => {
  it("coverage far outside 0.74-0.86 with n>=100 closes the whole gap in one night", () => {
    const r = recs(200, 11);
    const target = kOf(fitCalibration(r));
    const prev = Math.min(2.4, target + 1.2);
    const normal = kOf(fitCalibration(r, new Map([[B, prev]])));
    const full = kOf(fitCalibration(r, new Map([[B, prev]]), 0.8, { previousCoverage: new Map([[B, 0.4]]) }));
    assert.ok(Math.abs(full - target) < Math.abs(normal - target) + 1e-9 && Math.abs(full - target) < 0.02, `${full} vs ${target} (normal ${normal})`);
    const inBand = kOf(fitCalibration(r, new Map([[B, prev]]), 0.8, { previousCoverage: new Map([[B, 0.8]]) }));
    assert.equal(inBand, normal);
  });
  it("drift guard halves the step only when the last moves alternate", () => {
    assert.equal(isOscillating([1, 1.3, 1, 1.3, 1]), true);
    assert.equal(isOscillating([1, 1.1, 1.2, 1.3, 1.4]), false);
    assert.equal(isOscillating([1, 1.3, 1]), false);
    assert.equal(isOscillating(undefined), false);
    const r = recs(120, 12);
    const target = kOf(fitCalibration(r));
    const prev = Math.min(2.4, target + 0.5);
    const plain = Math.abs(kOf(fitCalibration(r, new Map([[B, prev]]))) - prev);
    const guarded = Math.abs(kOf(fitCalibration(r, new Map([[B, prev]]), 0.8, { history: new Map([[B, [1, 1.4, 1, 1.4, 1]]]) })) - prev);
    assert.ok(guarded < plain, `${guarded} < ${plain}`);
  });
});

describe("Judge band fit", () => {
  const mk = (n: number, seed: number, sd: number, relBias: Record<string, number> = {}) => {
    const { u: g, normal: gauss } = rng(seed);
    return Array.from({ length: n }, () => {
      const truth = 100;
      const rel = RELATIVE_BANDS[Math.floor(g() * 9)];
      const pSame = (["certain", "likely", "unsure"] as const)[Math.floor(g() * 3)];
      return { truthUsd: truth, comps: [{ priceUsd: truth * Math.exp(sd * gauss() - (relBias[rel] ?? 0)), pSame, relative: rel }] };
    });
  };
  it("too little data writes nothing", () => assert.deepEqual(fitJudgeBands(mk(5, 1, 0.1)), []));
  it("noisy bands get a larger variance than the default only when the data says so, always bounded", () => {
    const rows = fitJudgeBands(mk(2000, 2, 0.35));
    const same = rows.filter((r) => r.kind === "p_same");
    assert.ok(same.length === 3 && same.every((r) => r.value >= 0.005 && r.value <= 0.5 && r.n >= MIN_BAND_N));
    assert.ok(same.find((r) => r.band === "certain")!.value > P_SAME_SE2.certain);
  });
  it("a biased relative band is corrected toward the truth, by at most the nightly bound, order kept", () => {
    const rows = fitJudgeBands(mk(4000, 3, 0.05, { much_better: -0.3 })); // ad prices of much_better ads are 30% too high -> factor should fall
    const mb = rows.find((r) => r.band === "much_better")!;
    assert.ok(mb.value < RELATIVE_FACTOR.much_better && mb.value >= RELATIVE_FACTOR.much_better * Math.exp(-0.12) - 1e-3, String(mb.value));
  });
  it("applyAdCalibration ignores garbage, keeps the band order and can be reset", () => {
    applyAdCalibration([
      { kind: "p_same", band: "certain", value: NaN, n: 99 },
      { kind: "p_same", band: "unsure", value: 0.01, n: 99 },
      { kind: "p_same", band: "no", value: 0.1, n: 99 },
      { kind: "relative_factor", band: "better", value: 0.2, n: 99 },
      { kind: "relative_factor", band: "worse", value: 1.4, n: 99 },
    ]);
    assert.equal(P_SAME_SE2.certain, 0.03);
    assert.ok(P_SAME_SE2.unsure >= P_SAME_SE2.likely && P_SAME_SE2.likely >= P_SAME_SE2.certain);
    assert.equal(P_SAME_SE2.no, Infinity);
    for (let i = 1; i < 9; i++) assert.ok(RELATIVE_FACTOR[RELATIVE_BANDS[i]] > RELATIVE_FACTOR[RELATIVE_BANDS[i - 1]], RELATIVE_BANDS[i]);
    assert.equal(RELATIVE_FACTOR.equal, 1);
    resetAdCalibration();
    assert.equal(P_SAME_SE2.unsure, 0.12);
    assert.equal(RELATIVE_FACTOR.worse, 0.84);
  });
});
