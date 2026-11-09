// Learned price level and foreign noise per country pair (_shared/offsets.ts, interval.ts, pipeline.ts, handler.ts).
// What these tests protect: nothing moves a price without real evidence, a shift is always small and always
// replayable, and a broken table can never break or delay an answer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookupOffset, offsetTable, parseOffsetRows } from "../offsets.ts";
import type { OffsetRow } from "../offsets.ts";
import { refreshPriceOffsets } from "../../value-item/handler.ts";
import { foreignStdOf, safeShift } from "../../value-item/interval.ts";
import { buildFusedInterval as buildInterval } from "../../value-item/fused-interval.ts";
import type { RawComp } from "../../value-item/interval.ts";
import { assemble, intervalRecipeOf } from "../../value-item/pipeline.ts";
import type { Finding } from "../../value-item/types.ts";
import { OFFSET_CLAMP, FOREIGN_STD } from "../../value-item/interval.config.ts";
import { fakeStore, sampleVerdict } from "../../value-item/tests/helpers.ts";

const comp = (priceUsd: number, over: Partial<RawComp> = {}): RawComp => ({ priceUsd, kind: "sold", match: "same", tier: "global", origin: "US", ...over });
const US6 = [100, 104, 98, 102, 101, 99].map((p) => comp(p));

describe("table: reading it back is safe", () => {
  const good: OffsetRow = { origin: "US", user_country: "SE", offset_ln: -0.12, extra_std: 0.22, n: 45, baseline_ln: 0 };

  it("parseOffsetRows drops malformed rows", () => {
    const rows = parseOffsetRows([good, { origin: "USA" }, null, { ...good, user_country: "US" }, { ...good, n: "x" }, "zzz"]);
    assert.equal(rows.length, 1);
    assert.equal(parseOffsetRows("nope").length, 0);
  });

  it("lookupOffset: found, not found, same country, unknown country", () => {
    const t = offsetTable([good]);
    assert.deepEqual(lookupOffset(t, "US", "SE"), { shiftLn: -0.12, extraStd: 0.22 });
    assert.deepEqual(lookupOffset(t, "us", "se"), { shiftLn: -0.12, extraStd: 0.22 });
    assert.equal(lookupOffset(t, "DE", "SE"), null);
    assert.equal(lookupOffset(t, "SE", "SE"), null);
    assert.equal(lookupOffset(t, "US", "ZZ"), null);
    assert.equal(lookupOffset(t, "US", null), null);
    assert.equal(lookupOffset(undefined, "US", "SE"), null);
  });

  it("a hand-edited or thin row cannot do harm: shift re-clamped, too few reports count for nothing", () => {
    const t = offsetTable([{ ...good, offset_ln: -0.9 }, { origin: "GB", user_country: "SE", offset_ln: -0.2, extra_std: 0.3, n: 10, baseline_ln: 0 }]);
    assert.equal(lookupOffset(t, "US", "SE")!.shiftLn, -OFFSET_CLAMP);
    assert.equal(lookupOffset(t, "GB", "SE"), null);
  });
});

// ---------------------------------------------------------------- the pipeline

const foreign = (id: number, priceUsd: number): Finding => ({
  id, searchId: "s1", title: `Seiko ${id}`, snippet: "", url: `https://x.test/${id}`, site: "ebay.com", kind: "sold",
  price: priceUsd, currency: "USD", priceUsd, gl: "us", origin: "US", tier: "global",
});
const TABLE = offsetTable([{ origin: "US", user_country: "SE", offset_ln: -0.15, extra_std: 0.25, n: 60, baseline_ln: 0 }]);
const A = () => ({
  verdict: sampleVerdict({ same: [1, 2, 3, 4, 5], similar: [], price: { low: 80, mid: 100, high: 125 } }),
  ident: null, details: null, findings: [1, 2, 3, 4, 5].map((i) => foreign(i, 100 + i)),
  marketState: "ok" as const, soldTarget: 5, degraded: [], judgeRan: true, country: "SE",
});

describe("pipeline: the shift is applied, recorded and replayable", () => {
  it("the recipe carries origin, shift and learned noise for foreign comps only", () => {
    const r = intervalRecipeOf({ ...A(), priceOffsets: () => TABLE });
    for (const c of r.comps) {
      assert.equal(c.origin, "US");
      assert.equal(c.shiftLn, -0.15);
      assert.equal(c.extraStd, 0.25);
    }
    const none = intervalRecipeOf(A());
    assert.ok(none.comps.every((c) => c.shiftLn === undefined && c.extraStd === undefined), "no table, no shift");
    const otherUser = intervalRecipeOf({ ...A(), country: "DE", priceOffsets: () => TABLE });
    assert.ok(otherUser.comps.every((c) => c.shiftLn === undefined), "a table for SE says nothing about DE");
  });

  it("the displayed listing prices stay the real ones, and the result says it was adjusted", () => {
    const out = assemble({ ...A(), priceOffsets: () => TABLE });
    assert.ok(out.comparables.every((c) => c.price >= 101 && c.price <= 105), "listings are shown at their real price");
    assert.equal(out.market!.adjusted, true);
    assert.equal(assemble(A()).market!.adjusted, undefined);
  });

  it("the answer moves toward the lower local level, and the stored recipe replays to the same answer", () => {
    let recipe: unknown = null;
    const plain = assemble(A());
    const adj = assemble({ ...A(), priceOffsets: () => TABLE, onInterval: (_iv, r) => { recipe = r; } });
    assert.ok(adj.mid < plain.mid);
    const r = recipe as ReturnType<typeof intervalRecipeOf>;
    const replay = buildInterval({ ...r });
    assert.ok(Math.abs(replay.mid - adj.mid) < 0.5, "replayed from the stored comps");
  });

});

describe("handler cache: never breaks or delays an answer", () => {
  const log = () => undefined;
  it("loads once, then serves from the cache", async () => {
    const store = fakeStore();
    store.priceOffsets = [{ origin: "US", user_country: "SE", offset_ln: -0.1, extra_std: 0.2, n: 50, baseline_ln: 0 }];
    const get = refreshPriceOffsets(store, 1000, log);
    assert.equal(get(), undefined, "nothing has arrived yet");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lookupOffset(get(), "US", "SE")!.shiftLn, -0.1);
    refreshPriceOffsets(store, 2000, log);
    assert.equal(store.priceOffsetsCalls, 1);
  });

  it("a failing or hanging read leaves no table (no shift), never an error", async () => {
    const bad = fakeStore();
    bad.loadPriceOffsets = async () => { throw new Error("db down"); };
    assert.equal(refreshPriceOffsets(bad, 1000, log)(), undefined);
    const hang = fakeStore();
    hang.loadPriceOffsets = () => new Promise(() => undefined);
    assert.equal(refreshPriceOffsets(hang, 1000, log)(), undefined);
    assert.equal(refreshPriceOffsets(null, 1000, log)(), undefined);
  });
});
