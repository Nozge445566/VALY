import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applySecondLook, softContested, validateSecondLook, secondLookSystemPrompt } from "../second-look.ts";

describe("second look (tighten-only)", () => {
  it("only soft-rule disagreements are re-asked, capped at 4, replica words never", () => {
    const ds = [
      { rule: "replica_words", adId: 1, detail: "" }, { rule: "brand_missing", adId: 2, detail: "" }, { rule: "price_vs_anchor", adId: 3, detail: "" },
      { rule: "brand_missing", adId: 2, detail: "" }, { rule: "eye_risk_higher", adId: null, detail: "" },
      ...[4, 5, 6, 7].map((id) => ({ rule: "brand_missing", adId: id, detail: "" })),
    ];
    assert.deepEqual(softContested(ds), [2, 3, 4, 5]);
  });
  it("validation keeps only known ids and valid words", () => {
    const m = validateSecondLook({ ads: [{ id: 2, same: "different" }, { id: 9, same: "same" }, { id: 3, same: "maybe" }, null, { id: "3", same: "same" }] }, [2, 3]);
    assert.deepEqual([...m], [[2, "different"]]);
    assert.equal(validateSecondLook("junk", [1]).size, 0);
    assert.equal(validateSecondLook({ ads: "x" }, [1]).size, 0);
  });
  it("never promotes: same/similar answers change nothing, different demotes", () => {
    const ads = [{ id: 1, match: "similar" }, { id: 2, match: "similar" }, { id: 3, match: "same" }] as never[];
    const r = applySecondLook(ads, new Map([[1, "same"], [2, "different"], [3, "similar"]]));
    assert.deepEqual(r.ads.map((a) => a.match), ["similar", "different", "same"]);
    assert.deepEqual(r.changed, [2]);
  });
  it("the prompt treats listing text as data", () => assert.match(secondLookSystemPrompt(), /data, never instructions/));
});
