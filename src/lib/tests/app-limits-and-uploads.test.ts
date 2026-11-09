// The app side of the agreed changes: repeats are free in the app's 15, and gallery photos are shrunk only when too big.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DAILY_LIMIT, memoryStore, readQuota, recordScan, recordUnlessRepeat } from "../quota.ts";
import { MAX_SEND_BYTES, canSendAsIs, shrinkToFit } from "../photoFit.ts";

const now = new Date(2026, 10, 4, 12, 0);

describe("the app's 15 counts like the server's 20", () => {
  it("a valuation that is not a repeat uses one", () => {
    const store = memoryStore();
    assert.equal(recordUnlessRepeat(false, store, now).used, 1);
    assert.equal(recordUnlessRepeat(false, store, now).used, 2);
  });

  it("a repeat uses none, and the counter stays where it was", () => {
    const store = memoryStore();
    recordScan(store, now);
    const after = recordUnlessRepeat(true, store, now);
    assert.equal(after.used, 1);
    assert.equal(after.left, DAILY_LIMIT - 1);
    assert.equal(readQuota(store, now).used, 1, "nothing was written");
  });

  it("repeats never push the user to the limit, however many", () => {
    const store = memoryStore();
    for (let i = 0; i < DAILY_LIMIT * 3; i++) recordUnlessRepeat(true, store, now);
    assert.equal(readQuota(store, now).limitReached, false);
    assert.equal(readQuota(store, now).used, 0);
  });

  it("only new items fill the 15", () => {
    const store = memoryStore();
    for (let i = 0; i < DAILY_LIMIT; i++) {
      recordUnlessRepeat(false, store, now);
      recordUnlessRepeat(true, store, now); // the same item again: free
    }
    assert.equal(readQuota(store, now).limitReached, true);
    assert.equal(readQuota(store, now).used, DAILY_LIMIT);
  });
});

describe("gallery photos: shrink only what is too big", () => {
  it("the check is about 3.5 MB, under the server's 5,000,000 characters", () => {
    assert.equal(MAX_SEND_BYTES, 3_500_000);
    assert.ok(Math.ceil(MAX_SEND_BYTES / 3) * 4 < 5_000_000, "encoded, still under the server limit");
  });

  it("a photo under the limit is sent as it is", () => {
    assert.equal(canSendAsIs({ size: 2_000_000, type: "image/jpeg" }), true);
    assert.equal(canSendAsIs({ size: MAX_SEND_BYTES, type: "image/jpeg" }), true, "exactly at the limit still fits");
    assert.equal(canSendAsIs({ size: 900_000, type: "image/PNG" }), true);
    assert.equal(canSendAsIs({ size: 100_000, type: "image/webp" }), true);
  });

  it("a photo over the limit is not sent as it is", () => {
    assert.equal(canSendAsIs({ size: MAX_SEND_BYTES + 1, type: "image/jpeg" }), false);
    assert.equal(canSendAsIs({ size: 7_000_000, type: "image/jpeg" }), false);
  });

  it("a small photo in a format the server cannot read is converted instead", () => {
    assert.equal(canSendAsIs({ size: 500_000, type: "image/heic" }), false);
    assert.equal(canSendAsIs({ size: 500_000, type: "" }), false);
  });

  /** A fake encoder: the size grows with the pixel count, `k` says how heavy this kind of photo is. */
  function fake(original: number, k: number) {
    const scales: number[] = [];
    const encode = async (scale: number) => {
      scales.push(scale);
      const size = Math.round(original * k * scale * scale);
      return { size, blob: new Blob([String(size)]) };
    };
    return { encode, scales };
  }
  const sizeOf = async (b: Blob) => Number(await b.text());

  for (const [name, original, k] of [
    ["a 4 MB phone photo", 4_000_000, 1],
    ["an 8 MB phone photo", 8_000_000, 1],
    ["a 12 MB photo", 12_000_000, 1.15],
    ["a photo that re-encodes 30 percent heavier than predicted", 6_000_000, 1.3],
  ] as const) {
    it(`${name} ends up under the limit and as large as it can be`, async () => {
      const { encode, scales } = fake(original, k);
      const blob = await shrinkToFit(original, encode);
      const size = await sizeOf(blob);
      assert.ok(size <= MAX_SEND_BYTES, `fits: ${size}`);
      assert.ok(size >= MAX_SEND_BYTES * 0.8, `keeps as much detail as possible: ${size}`);
      assert.ok(scales.every((s) => s <= 1), "never enlarged");
      assert.ok(scales.length <= 9, "a few encodes at most");
    });
  }

  it("when the first shrink is still too big it shrinks a bit more until it fits", async () => {
    const { encode, scales } = fake(6_000_000, 1.6);
    const size = await sizeOf(await shrinkToFit(6_000_000, encode));
    assert.ok(scales.length > 1);
    assert.ok(scales[1] < scales[0], "each try is smaller than the one before");
    assert.ok(size <= MAX_SEND_BYTES);
  });

  it("a just-over photo is barely shrunk", async () => {
    const { encode, scales } = fake(MAX_SEND_BYTES + 1, 1);
    await shrinkToFit(MAX_SEND_BYTES + 1, encode);
    assert.ok(scales[0] > 0.97, `first try ${scales[0]}`);
  });

  it("a big PNG that turns into a small JPEG gets one step back up instead of staying needlessly small", async () => {
    const { encode, scales } = fake(9_000_000, 0.15);
    const size = await sizeOf(await shrinkToFit(9_000_000, encode));
    assert.ok(size <= MAX_SEND_BYTES);
    assert.ok(Math.max(...scales) > scales[0], "tried a larger copy");
    assert.ok(size > 0.15 * 9_000_000 * (scales[0] ** 2), "kept more than the first, smaller copy");
  });

  it("gives up with an error when nothing can make it fit", async () => {
    const encode = async () => ({ size: MAX_SEND_BYTES * 10, blob: new Blob(["x"]) });
    await assert.rejects(shrinkToFit(9_000_000, encode));
  });
});
