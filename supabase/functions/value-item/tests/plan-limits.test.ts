import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkLimits, normalizePlan } from "../plan-limits.ts";

describe("plan-limits", () => {
  it("free: 20 in total, never renews", () => {
    assert.equal(checkLimits("free", 3, 3, 19).ok, true);
    assert.deepEqual(checkLimits("free", 0, 0, 20), { ok: false, code: "limit_total", plan: "free" });
  });
  it("pro: 300 a month, no daily cap", () => {
    assert.equal(checkLimits("pro", 299, 299).ok, true);
    assert.equal(checkLimits("pro", 299, 500).ok, true); // no daily cap
    assert.deepEqual(checkLimits("pro", 300, 0), { ok: false, code: "limit_month", plan: "pro" });
  });
  it("premium: 1000 a month, no daily cap", () => {
    assert.equal(checkLimits("premium", 999, 299).ok, true);
    assert.equal(checkLimits("premium", 100, 5000).ok, true);
    assert.equal(checkLimits("premium", 1000, 0).ok, false);
  });
  it("business: 5000 a month, no daily cap", () => {
    assert.equal(checkLimits("business", 4999, 4999).ok, true);
    assert.deepEqual(checkLimits("business", 5000, 0), { ok: false, code: "limit_month", plan: "business" });
  });
  it("canceled or unknown plan is free", () => {
    assert.equal(normalizePlan("pro", "canceled"), "free");
    assert.equal(normalizePlan("gold"), "free");
    assert.equal(normalizePlan("premium"), "premium");
  });
});
