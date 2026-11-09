// The daily valuation limit (src/lib/quota.ts). Pure logic, no React.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DAILY_LIMIT, dayKey, memoryStore, nextMidnight, readQuota, recordScan, timeUntil } from "../quota.ts";
import { textsFor } from "../texts.ts";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe("src/lib/quota.ts", () => {
  it("starts at 15 and shows nothing before the second result", () => {
    const store = memoryStore();
    assert.equal(readQuota(store, at(2026, 10, 31)).left, DAILY_LIMIT);
    assert.equal(readQuota(store, at(2026, 10, 31)).showCounter, false);
    const first = recordScan(store, at(2026, 10, 31));
    assert.equal(first.left, 14);
    assert.equal(first.showCounter, false, "first result: no mention of a limit");
    const second = recordScan(store, at(2026, 10, 31));
    assert.equal(second.left, 13);
    assert.equal(second.showCounter, true, "second result: the counter appears");
  });

  it("locks at 15 and never counts past it", () => {
    const store = memoryStore();
    const now = at(2026, 10, 31);
    for (let i = 0; i < DAILY_LIMIT + 5; i++) recordScan(store, now);
    const s = readQuota(store, now);
    assert.equal(s.used, DAILY_LIMIT);
    assert.equal(s.left, 0);
    assert.equal(s.limitReached, true);
  });

  it("renews on a new local day", () => {
    const store = memoryStore();
    for (let i = 0; i < DAILY_LIMIT; i++) recordScan(store, at(2026, 10, 31, 23, 58));
    assert.equal(readQuota(store, at(2026, 10, 31, 23, 59)).limitReached, true);
    const next = readQuota(store, at(2026, 11, 1, 0, 1));
    assert.equal(next.limitReached, false);
    assert.equal(next.left, DAILY_LIMIT);
  });

  it("a broken or tampered stored value never locks the user out", () => {
    for (const bad of ["not json", "{}", '{"day":"2026-10-31","used":"x"}', '{"day":"2026-10-31","used":-4}', "null"]) {
      const store = memoryStore();
      store.setItem("valy.daily.v1", bad);
      const s = readQuota(store, at(2026, 10, 31));
      assert.equal(s.limitReached, false, bad);
      assert.ok(s.left <= DAILY_LIMIT && s.left >= 0);
    }
    const store = memoryStore();
    store.setItem("valy.daily.v1", JSON.stringify({ day: "2026-10-31", used: 999 }));
    assert.equal(readQuota(store, at(2026, 10, 31)).used, DAILY_LIMIT, "clamped");
  });

  it("a store that throws does not break counting for the render", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    assert.equal(readQuota(broken, at(2026, 10, 31)).left, DAILY_LIMIT);
    assert.equal(recordScan(broken, at(2026, 10, 31)).left, DAILY_LIMIT - 1);
  });

  it("dayKey and nextMidnight use the local calendar", () => {
    assert.equal(dayKey(at(2026, 1, 5)), "2026-01-05");
    const n = nextMidnight(at(2026, 12, 31, 23, 30));
    assert.equal(dayKey(n), "2027-01-01");
    assert.equal(n.getHours(), 0);
  });

  it("timeUntil rounds up and never reads 0m while locked", () => {
    const now = at(2026, 10, 31, 12, 0).getTime();
    assert.deepEqual(timeUntil(now + 90 * 60_000, now), { hours: 1, minutes: 30 });
    assert.deepEqual(timeUntil(now + 1_000, now), { hours: 0, minutes: 1 });
    assert.deepEqual(timeUntil(now - 5_000, now), { hours: 0, minutes: 1 });
  });

  it("texts exist in both languages and say the numbers", () => {
    for (const lang of ["en", "sv"] as const) {
      const q = textsFor(lang).quota;
      assert.match(q.left(14, 15), /14/);
      assert.match(q.left(14, 15), /15/);
      assert.match(q.renewsIn(2, 5), /2/);
      assert.match(q.renewsIn(0, 5), /5/);
      assert.ok(q.reachedTitle(15).includes("15") && q.used(15).includes("15"));
      assert.ok(q.reachedBody.length > 0 && q.doneNote.length > 0);
      assert.ok(!/!/.test(q.reachedTitle(15) + q.reachedBody + q.doneNote), "house tone: no exclamation marks");
    }
  });
});

import nodeTest from "node:test";
import { memoryStore as _mem, recordScan as _rec, readQuota as _read } from "../quota.ts";

nodeTest("plan-driven limits: free is 20 in total (never renews), pro is 300 a month, no daily cap", () => {
  const now = new Date(2026, 10, 14, 12);
  const free = _mem();
  for (let i = 0; i < 20; i++) _rec(free, now, "free");
  const f = _read(free, now, "free");
  assert.equal(f.limitReached, true);
  assert.equal(f.monthMax, 20);
  assert.equal(f.lifetime, true);
  assert.equal(_read(free, new Date(2027, 0, 1, 9), "free").limitReached, true); // never renews
  const pro = _mem();
  for (let i = 0; i < 300; i++) _rec(pro, now, "pro");
  assert.equal(_read(pro, now, "pro").limitReached, true);
  assert.equal(_read(pro, new Date(2026, 10, 15, 9), "pro").limitReached, true); // still the same month
  assert.equal(_read(pro, new Date(2026, 11, 1, 9), "pro").limitReached, false); // renews on the 1st
  assert.equal(_read(_mem(), now).max, 15); // no plan = old device rule
});
