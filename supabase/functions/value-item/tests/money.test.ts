import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractMoney, listingKind, parseAmount } from "../money.ts";

describe("extractMoney", () => {
  it("reads dollar, euro and code prices", () => {
    assert.deepEqual(extractMoney("Vintage lamp sold for $45.00 on eBay", { host: "ebay.com", gl: "us" })[0], { price: 45, currency: "USD" });
    assert.deepEqual(extractMoney("Asking 120 EUR, pickup only")[0], { price: 120, currency: "EUR" });
    assert.deepEqual(extractMoney("Only 1.234,56 € today", { host: "ebay.de", gl: "de" })[0], { price: 1234.56, currency: "EUR" });
  });

  it("reads Swedish kronor written with kr or :-", () => {
    assert.deepEqual(extractMoney("Mässingslampa 1 250 kr", { host: "tradera.com", gl: "se" })[0], { price: 1250, currency: "SEK" });
    assert.deepEqual(extractMoney("Seiko 5 | 4 500 :-", { host: "blocket.se", gl: "se" })[0], { price: 4500, currency: "SEK" });
  });

  it("does not guess when kr has no country to go with it", () => {
    assert.equal(extractMoney("Lampa 300 kr", { host: "example.com", gl: "us" }).length, 0);
  });

  it("uses the site to tell dollars apart", () => {
    assert.equal(extractMoney("Watch $120", { host: "ebay.com.au", gl: "au" })[0].currency, "AUD");
    assert.equal(extractMoney("Watch $120", { host: "ebay.ca", gl: "ca" })[0].currency, "CAD");
    assert.equal(extractMoney("Watch $120", { host: "ebay.com", gl: "au" })[0].currency, "USD");
  });

  it("skips shipping prices and old prices", () => {
    assert.deepEqual(extractMoney("US $12.50 + $5.00 shipping").map((m) => m.price), [12.5]);
    assert.deepEqual(extractMoney("Was $200, now $120", { host: "ebay.com", gl: "us" }).map((m) => m.price), [120]);
    assert.deepEqual(extractMoney("Skatepark 1.234,56 € frakt 49 €", { host: "ebay.de", gl: "de" }).map((m) => m.price), [1234.56]);
  });

  it("ignores tiny numbers and numbers without a currency", () => {
    assert.equal(extractMoney("model 2 release").length, 0);
    assert.equal(extractMoney("$3").length, 0);
    assert.equal(extractMoney("Reference 114060 steel").length, 0);
  });
});

describe("parseAmount", () => {
  it("understands both decimal styles", () => {
    assert.equal(parseAmount("1,234.56"), 1234.56);
    assert.equal(parseAmount("1.234,56"), 1234.56);
    assert.equal(parseAmount("12,50"), 12.5);
    assert.equal(parseAmount("1,234"), 1234);
    assert.equal(parseAmount("1 234"), 1234);
  });
});

describe("listingKind", () => {
  it("marks a listing sold only when the text says the price was paid", () => {
    assert.equal(listingKind("Sold Oct 12, 2026"), "sold");
    assert.equal(listingKind("Slutpris 400 kr"), "sold");
    assert.equal(listingKind("verkauft für 20 €"), "sold");
    assert.equal(listingKind("落札 5000円"), "sold");
  });
  it("does not mistake other uses of the word", () => {
    assert.equal(listingKind("Sold by Amazon"), "asking");
    assert.equal(listingKind("Sold out"), "asking");
    assert.equal(listingKind("Not sold"), "asking");
    assert.equal(listingKind("Buy it now"), "asking");
  });
});

import { extractMoney as readWorldMoney } from "../money.ts";
import { strict as assertWorld } from "node:assert";
describe("extractMoney: currencies of the whole world (owner order 1o item 2)", () => {
  const cases: [string, string, number][] = [
    ["Rs. 4,500 only", "INR", 4500], ["Rp 1.500.000", "IDR", 1500000], ["₫ 2.000.000", "VND", 2000000], ["RM 120", "MYR", 120],
    ["S/ 150", "PEN", 150], ["Ksh 5,000", "KES", 5000], ["₦ 45,000", "NGN", 45000], ["₪ 300", "ILS", 300], ["฿ 1,000", "THB", 1000],
    ["Lei 200", "RON", 200], ["лв 100", "BGN", 100], ["₴ 900", "UAH", 900], ["руб. 5000", "RUB", 5000], ["15000 دج", "DZD", 15000],
    ["د.إ 300", "AED", 300], ["ر.س 200", "SAR", 200], ["EGP 300", "EGP", 300], ["MAD 200", "MAD", 200], ["Seiko KWD 12.500", "KWD", 12.5],
  ];
  for (const [text, cur, price] of cases) {
    it(`reads ${text}`, () => {
      const m = readWorldMoney(text, { host: "", gl: "" });
      assertWorld.equal(m[0]?.currency, cur);
      assertWorld.equal(m[0]?.price, price);
    });
  }
  it("Rs on a Sri Lankan or Pakistani page is not rupees of India", () => {
    assertWorld.equal(readWorldMoney("Rs 4,500", { host: "ikman.lk", gl: "lk" })[0]?.currency, "LKR");
    assertWorld.equal(readWorldMoney("Rs 4,500", { host: "olx.com.pk", gl: "pk" })[0]?.currency, "PKR");
  });
  it("Ft is only forint on a Hungarian page (it is also feet), and everyday words are never currencies", () => {
    assertWorld.equal(readWorldMoney("15 000 Ft", { host: "hasznaltauto.hu", gl: "hu" })[0]?.currency, "HUF");
    assertWorld.equal(readWorldMoney("6 ft 200", { host: "", gl: "" }).length, 0);
    assertWorld.equal(readWorldMoney("all 100 sizes top 50", { host: "", gl: "" }).length, 0);
  });
});
