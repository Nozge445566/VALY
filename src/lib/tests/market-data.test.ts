// The logic behind "Se marknadsdata" / "Se hur vi värderade" (src/lib/marketData.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExplainInput, currencyUnit, insightKind, marketRows, rowSubline, rowTitle, searchRows, sourceOf } from "../marketData.ts";

const ad = (url: string, price = 420, title = "Mässingslampa") => ({ title, url, price });
const fmt = (n: number) => `${n} kr`;

describe("src/lib/marketData.ts", () => {
  it("insightKind: market only with enough ads, otherwise explain, never both", () => {
    assert.equal(insightKind({ marketAds: [1, 2, 3], minAds: 2 }), "market");
    assert.equal(insightKind({ marketAds: [1, 2], minAds: 2 }), "market");
    assert.equal(insightKind({ marketAds: [1], minAds: 2 }), "explain");
    assert.equal(insightKind({ marketAds: [], minAds: 2 }), "explain");
    assert.equal(insightKind({}), "explain");
    assert.equal(insightKind({ marketAds: [1], minAds: 1 }), "market");
  });

  it("sourceOf: known sites by name, others by domain, junk is null", () => {
    assert.equal(sourceOf("https://www.tradera.com/item/1")?.name, "Tradera");
    assert.equal(sourceOf("https://www.blocket.se/annons/1")?.name, "Blocket");
    assert.equal(sourceOf("https://www.ebay.de/itm/1")?.name, "eBay");
    assert.equal(sourceOf("https://www.vinted.se/items/1")?.name, "Vinted");
    assert.equal(sourceOf("javascript:alert(1)"), null);
    assert.equal(sourceOf("not a url"), null);
  });

  it("without rights a row is a plain link with the source's name: no title, price or image", () => {
    const rows = marketRows([ad("https://www.tradera.com/item/1"), ad("https://www.blocket.se/annons/2")], "Mässingslampa", { formatPrice: fmt });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.title, null);
      assert.equal(r.price, null);
      assert.equal(r.image, null);
      assert.equal(r.kind, "ad");
    }
    assert.equal(rowTitle(rows[0]), "Tradera");
    assert.equal(rowSubline(rows[0]), null);
    assert.equal(rows[0].href, "https://www.tradera.com/item/1");
  });

  it("at most three rows", () => {
    const ads = [1, 2, 3, 4, 5].map((i) => ad(`https://www.tradera.com/item/${i}`));
    assert.equal(marketRows(ads, "x", { formatPrice: fmt }).length, 3);
  });

  it("a dead link becomes the source's search page, and duplicates collapse", () => {
    const a = ad("https://www.tradera.com/item/1");
    const b = ad("https://www.tradera.com/item/2");
    const c = ad("https://www.blocket.se/annons/3");
    const rows = marketRows([a, b, c], "Mässingslampa åttio", { dead: new Set([a.url, b.url]), formatPrice: fmt });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, "search");
    assert.equal(rows[0].href, `https://www.tradera.com/search?q=${encodeURIComponent("Mässingslampa åttio")}`);
    assert.equal(rows[1].href, c.url);
  });

  it("nothing usable left: one search row per site", () => {
    const a = ad("https://www.vinted.se/items/1");
    const rows = marketRows([a], "lampa", { dead: new Set([a.url]), formatPrice: fmt });
    assert.deepEqual(rows.map((r) => r.source), ["Tradera", "Blocket", "eBay"]);
    assert.ok(rows.every((r) => r.kind === "search" && r.image === null && r.price === null));
    assert.equal(searchRows("lampa").length, 3);
  });

  it("a non-http link is never shown", () => {
    assert.equal(marketRows([ad("javascript:alert(1)")], "x", { formatPrice: fmt })[0].kind, "search");
  });

  it("buildExplainInput: unknown stays null and nothing is invented", () => {
    const input = buildExplainInput({ itemName: "Lampa", currency: "SEK", low: 300, mid: 450, high: 600, conditionLabel: null, comparableCount: 0 }, "sv-SE");
    assert.equal(input.foremal, "Lampa");
    assert.equal(input.identifiering_sakerhet, null);
    assert.equal(input.tid_ursprung, null);
    assert.equal(input.material, null);
    assert.equal(input.skick, null);
    assert.equal(input.marknadsdata_finns, false);
    assert.equal(input.hogt_varde_eller_antikt, false);
    assert.equal(input.varde, 450);
    assert.deepEqual(input.intervall, [300, 600]);
    assert.equal(input.valuta, "kr");
    assert.equal(input.underlag_for_pris.length, 1);
  });

  it("buildExplainInput: facts and weak ads are passed on", () => {
    const input = buildExplainInput(
      { itemName: "Empirestol", currency: "SEK", low: 3500, mid: 4500, high: 6000, conditionLabel: "bra", comparableCount: 2, explain: { era: "1820-talet", origin: "Sverige", material: "mahogny", identConfidence: 90, highValueOrAntique: true } },
      "sv-SE",
    );
    assert.equal(input.identifiering_sakerhet, 0.9);
    assert.equal(input.tid_ursprung, "Sverige, 1820-talet");
    assert.equal(input.material, "mahogny");
    assert.equal(input.hogt_varde_eller_antikt, true);
    assert.equal(input.underlag_for_pris.length, 2);
  });

  it("currencyUnit falls back to the code", () => {
    assert.equal(currencyUnit("SEK", "sv-SE"), "kr");
    assert.equal(currencyUnit("???", "sv-SE"), "???");
  });
});
