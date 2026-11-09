import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blendAlpha, bucketOfStored, fitCalibration, K_CEIL, K_FLOOR, MIN_BUCKET_N, moveLimit } from "../calibration-fit.ts";
import { simulate } from "../../value-item/backtest.ts";

const withBucket = (n: number, seed: number, bucket: string, extra: object = {}) => simulate({ runs: n, seed, ...extra }).map((r) => ({ ...r, bucket }));

describe("nightly calibration fit", () => {
  it("no data or too little data writes nothing", () => {
    assert.deepEqual(fitCalibration([]), []);
    assert.deepEqual(fitCalibration(withBucket(MIN_BUCKET_N - 1, 1, "electronics|strong|local")), []);
  });
  it("rows are bounded, finite, include the parent chain, and measured coverage is near the target", () => {
    const rows = fitCalibration([...withBucket(120, 2, "electronics|strong|local"), ...withBucket(60, 3, "watch|medium|local")]);
    const buckets = rows.map((r) => r.bucket);
    for (const b of ["electronics|strong|local", "electronics|strong", "strong", "global"]) assert.ok(buckets.includes(b), b);
    for (const r of rows) { assert.ok(r.k >= K_FLOOR && r.k <= K_CEIL && Number.isFinite(r.k) && r.n >= MIN_BUCKET_N); assert.ok(r.coverage >= 0 && r.coverage <= 1); }
    const own = rows.find((r) => r.bucket === "electronics|strong|local")!;
    assert.ok(Math.abs(own.coverage - 0.8) < 0.12, `coverage ${own.coverage}`);
  });
  it("more data closes more of the gap in one night, and the allowed jump grows with n", () => {
    assert.ok(blendAlpha(40) < blendAlpha(120) && blendAlpha(120) < blendAlpha(400) && blendAlpha(1e9) <= 0.95 && blendAlpha(0) >= 0.4);
    assert.ok(moveLimit(30) < moveLimit(150) && moveLimit(1e6) === 1.5 && moveLimit(0) === 0.25);
    const recs = withBucket(300, 9, "electronics|strong|local");
    const fitted = fitCalibration(recs).find((r) => r.bucket === "electronics|strong|local")!.k;
    const prev = Math.min(2.4, fitted + 1);
    const moved = fitCalibration(recs, new Map([["electronics|strong|local", prev]])).find((r) => r.bucket === "electronics|strong|local")!.k;
    assert.ok(prev - moved >= 0.5, `moved only ${prev - moved}`); // old fixed cap would have allowed 0.25
  });
  it("one night never exceeds the data-dependent limit; garbage records are ignored", () => {
    const recs = [...withBucket(120, 4, "electronics|strong|local"), { bucket: "", truthUsd: 5, stored: {} as never }, { bucket: "x|y|z", truthUsd: NaN, stored: {} as never }];
    const rows = fitCalibration(recs, new Map([["electronics|strong|local", 1.5]]));
    const own = rows.find((r) => r.bucket === "electronics|strong|local")!;
    assert.ok(Math.abs(own.k - 1.5) <= moveLimit(120) + 1e-9);
  });
  it("bucketOfStored accepts only sane keys", () => {
    assert.equal(bucketOfStored({ bucket: "a|b|c" }), "a|b|c");
    for (const bad of [undefined, 5, "", "has space", "x".repeat(200)]) assert.equal(bucketOfStored({ bucket: bad }), null);
  });
});
