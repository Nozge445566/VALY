// The pure helpers behind the country tag and the history (src/lib/market.ts). No React here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanCountry, foreignDataSentence, foreignOrigins, historyBasisChip, historyCountryTag, joinNames, listingTag, marketColumns, readMarket, readTier,
} from "../market.ts";
import { FOREIGN_DATA_NOTE, TEXTS } from "../texts.ts";

describe("src/lib/market.ts", () => {
  it("cleanCountry: only real codes, never the unknown ZZ", () => {
    assert.equal(cleanCountry("de"), "DE");
    assert.equal(cleanCountry(" se "), "SE");
    for (const bad of ["ZZ", "", "DEU", "1A", null, undefined, 5]) assert.equal(cleanCountry(bad), null);
  });

  it("readTier", () => {
    assert.equal(readTier("regional"), "regional");
    assert.equal(readTier("nope"), undefined);
  });

  it("readMarket: old or broken results become null or unknown, never throw", () => {
    assert.equal(readMarket(undefined), null);
    assert.equal(readMarket("x"), null);
    assert.deepEqual(readMarket({ country: "se", basis: "regional", local: 1, regional: 4, global: -2 }),
      { country: "SE", basis: "regional", local: 1, regional: 4, global: 0, adjusted: false });
    assert.equal(readMarket({ country: "SE", basis: "global", adjusted: true })!.adjusted, true);
    assert.equal(readMarket({ country: "SE", basis: "global", adjusted: "yes" })!.adjusted, false, "only a real true counts");
    assert.equal(readMarket({ country: "Sweden", basis: "weird" })!.country, "ZZ");
    assert.equal(readMarket({ basis: "weird" })!.basis, "none");
  });

  it("listingTag: only listings from another country get a tag", () => {
    assert.equal(listingTag({ origin: "DE", tier: "regional" }), "DE");
    assert.equal(listingTag({ origin: "US", tier: "global" }), "US");
    assert.equal(listingTag({ origin: "SE", tier: "local" }), null);
    assert.equal(listingTag({ origin: "SE" }), null, "old results have no tier: no tag");
    assert.equal(listingTag({ origin: "ZZ", tier: "global" }), null);
  });

  it("foreignDataSentence: names the countries, only for foreign evidence, and the owner's switch is ON", () => {
    assert.equal(FOREIGN_DATA_NOTE, true, "the owner asked that a foreign number is not visible only through a tag");
    const m = (basis: "local" | "regional" | "global" | "none", adjusted = false) => ({ country: "SE", basis, local: 0, regional: 0, global: 0, adjusted });
    const us = [{ origin: "US", tier: "global" as const }, { origin: "US", tier: "global" as const }, { origin: "DE", tier: "regional" as const }, { origin: "SE", tier: "local" as const }];
    assert.equal(foreignDataSentence(null), null);
    assert.equal(foreignDataSentence(m("local"), us), null);
    assert.equal(foreignDataSentence(m("none"), us), null);
    const g = foreignDataSentence(m("global"), us, "en")!;
    assert.match(g, /United States/);
    assert.match(g, /Germany/);
    assert.ok(!/Sweden/.test(g), "the user's own country is never named as foreign");
    assert.equal(g, TEXTS.foreignData.global("United States and Germany"));
    assert.equal(foreignDataSentence(m("regional"), [{ origin: "NO", tier: "regional" }], "en"), TEXTS.foreignData.regional("Norway"));
  });

  it("foreignDataSentence: no listing names a country (only 5 are shown): generic words, never an empty gap", () => {
    const m = { country: "SE", basis: "global" as const, local: 0, regional: 0, global: 4, adjusted: false };
    assert.equal(foreignDataSentence(m, []), TEXTS.foreignData.global(TEXTS.foreignData.genericGlobal));
    assert.equal(foreignDataSentence({ ...m, basis: "regional" }), TEXTS.foreignData.regional(TEXTS.foreignData.genericRegional));
  });

  it("foreignDataSentence: says so when the prices were adjusted to the local level", () => {
    const m = { country: "SE", basis: "global" as const, local: 0, regional: 0, global: 4, adjusted: true };
    const s = foreignDataSentence(m, [{ origin: "US", tier: "global" }], "en")!;
    assert.ok(s.endsWith(TEXTS.foreignData.adjusted));
    assert.ok(!foreignDataSentence({ ...m, adjusted: false }, [{ origin: "US", tier: "global" }], "en")!.includes("adjusted"));
  });

  it("foreignOrigins and joinNames", () => {
    assert.deepEqual(foreignOrigins([{ origin: "US", tier: "global" }, { origin: "DE", tier: "regional" }, { origin: "DE", tier: "regional" }]), ["DE", "US"]);
    assert.deepEqual(foreignOrigins([{ origin: "SE", tier: "local" }, { origin: "ZZ", tier: "global" }, { origin: "US" }]), []);
    assert.equal(foreignOrigins(["AA", "BB", "CC"].map((origin) => ({ origin, tier: "global" as const }))).length, 2, "at most two");
    assert.equal(joinNames([]), "");
    assert.equal(joinNames(["A"]), "A");
    assert.equal(joinNames(["A", "B"]), "A and B");
    assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
  });

  it("historyBasisChip: a chip only for regional or global evidence", () => {
    assert.equal(historyBasisChip("local"), null);
    assert.equal(historyBasisChip("none"), null);
    assert.equal(historyBasisChip(null), null);
    assert.equal(historyBasisChip(undefined), null);
    assert.equal(historyBasisChip("weird"), null);
    assert.equal(historyBasisChip("regional")!.label, TEXTS.foreignData.nearbyMarkets);
    assert.equal(historyBasisChip("global")!.label, TEXTS.foreignData.otherMarkets);
    assert.ok(historyBasisChip("global")!.title.length > 5);
  });

  it("historyCountryTag: shown only when the row was made for another country than the device's", () => {
    assert.equal(historyCountryTag("SE", "DE"), "SE");
    assert.equal(historyCountryTag("se", "DE"), "SE");
    assert.equal(historyCountryTag("DE", "DE"), null);
    assert.equal(historyCountryTag("SE", null), "SE", "device country unknown: still say where it was made");
    assert.equal(historyCountryTag(null, "DE"), null, "old rows: unknown, no tag");
    assert.equal(historyCountryTag("ZZ", "DE"), null);
  });

  it("marketColumns: what is saved next to a valuation", () => {
    assert.deepEqual(marketColumns({ market: null, currency: "SEK" }), { market_country: null, market_basis: null, market_adjusted: null, currency: "SEK" });
    assert.deepEqual(marketColumns({ market: readMarket({ country: "SE", basis: "global" }), currency: "SEK" }),
      { market_country: "SE", market_basis: "global", market_adjusted: false, currency: "SEK" });
    assert.equal(marketColumns({ market: readMarket({ country: "SE", basis: "global", adjusted: true }), currency: "SEK" }).market_adjusted, true);
  });

  it("historyBasisChip: an adjusted row says so in the tooltip only", () => {
    const plain = historyBasisChip("global", false)!;
    const adj = historyBasisChip("global", true)!;
    assert.equal(adj.label, plain.label);
    assert.ok(adj.title.includes(TEXTS.foreignData.adjusted));
    assert.ok(!plain.title.includes(TEXTS.foreignData.adjusted));
    assert.equal(historyBasisChip("global", null)!.title, plain.title, "old rows: no claim");
    assert.equal(historyBasisChip("local", true), null, "local evidence never gets a chip");
  });
});
