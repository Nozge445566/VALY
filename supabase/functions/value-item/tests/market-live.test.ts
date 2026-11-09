import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FALLBACK_RATES } from "../fx.ts";
import { hitsToFindings, runMarketLive, selectFindings, serperHits } from "../market-live.ts";
import type { PlannedSearch, SearchPlan } from "../types.ts";
import { json, makeDeps, serperSold, sleepMs, testConfig } from "./helpers.ts";

const search = (id: string, query: string, gl = "us"): PlannedSearch => ({ id, query, template_id: `t_${id}`, kind: "exploit", gl, hl: "en" });
const plan = (n = 4): SearchPlan => ({
  strategyVersion: 3,
  source: "search_ai",
  searches: ["s1", "s2", "s3", "s4"].slice(0, n).map((id) => search(id, `query ${id}`)),
  stop: { soldPrices: 5, maxMs: 2000 },
});

describe("hitsToFindings", () => {
  it("keeps priced hits, converts to USD, drops duplicates and unpriced hits", () => {
    const hits = [
      { title: "Seiko 5 SNK809", url: "https://www.ebay.de/itm/1", snippet: "Verkauft 92,00 EUR" },
      { title: "Seiko 5 SNK809 again", url: "https://ebay.de/itm/1/", snippet: "Verkauft 92,00 EUR" },
      { title: "No price here", url: "https://example.com/x", snippet: "nice watch" },
      { title: "Bad link", url: "not-a-url", snippet: "$50" },
    ];
    const seen = new Set<string>();
    const { findings, dropped } = hitsToFindings(serperHits({ organic: hits.map((h) => ({ title: h.title, link: h.url, snippet: h.snippet })) }), search("s1", "q", "de"), FALLBACK_RATES, seen);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "sold");
    assert.equal(findings[0].currency, "EUR");
    assert.ok(Math.abs(findings[0].priceUsd - 92 / FALLBACK_RATES.EUR) < 0.05);
    assert.equal(dropped, 2);
  });
});

describe("selectFindings", () => {
  it("puts sold first, caps at 16 and numbers from 1", () => {
    const mk = (i: number, kind: "sold" | "asking") => ({ searchId: "s1", title: `t${i}`, snippet: "", url: `https://x.com/${i}`, site: "x.com", kind, price: 10, currency: "USD", priceUsd: 10, gl: "us" });
    const all = [...Array.from({ length: 12 }, (_, i) => mk(i, "asking")), ...Array.from({ length: 8 }, (_, i) => mk(100 + i, "sold"))];
    const out = selectFindings(all);
    assert.equal(out.length, 16);
    assert.equal(out[0].kind, "sold");
    assert.equal(out[0].id, 1);
    assert.equal(out[15].id, 16);
  });
});

describe("runMarketLive (the stopper)", () => {
  it("stops at 5 sold prices and cancels the searches still running", async () => {
    const { deps } = makeDeps(async (call, signal) => {
      const q = String(call.body?.q);
      if (q === "query s1") return serperSold(5, 60, "a");
      await sleepMs(1500, signal); // slow searches: they must be cancelled
      return serperSold(5, 70, "b");
    });
    const t0 = Date.now();
    const report = await runMarketLive(deps, testConfig(), plan(), { budgetMs: 2000, rates: FALLBACK_RATES });
    assert.equal(report.stopReason, "target");
    assert.ok(Date.now() - t0 < 700, "must not wait for the slow searches");
    assert.equal(report.soldCount, 5);
    const cancelled = report.outcomes.filter((o) => o.cancelled).length;
    assert.equal(cancelled, 3);
  });

  it("stops at 2.0 s and uses what has arrived", async () => {
    const { deps } = makeDeps(async (call, signal) => {
      const q = String(call.body?.q);
      if (q === "query s1") return serperSold(2, 60, "a");
      await sleepMs(5000, signal);
      return serperSold(5, 70, "b");
    });
    const t0 = Date.now();
    const report = await runMarketLive(deps, testConfig({ searchMs: 500 }), plan(), { budgetMs: 2000, rates: FALLBACK_RATES });
    const took = Date.now() - t0;
    assert.equal(report.stopReason, "time");
    assert.ok(took >= 450 && took < 1200, `took ${took}`);
    assert.equal(report.soldCount, 2);
    assert.equal(report.findings.length, 2);
  });

  it("never runs more than 4 searches and sends the country and language to Serper", async () => {
    const { deps, calls } = makeDeps(async () => serperSold(1, 50, "z"));
    const big = plan();
    big.searches.push(search("s4", "fifth"));
    big.searches[1] = search("s2", "query s2", "se");
    await runMarketLive(deps, testConfig(), big, { budgetMs: 2000, rates: FALLBACK_RATES });
    const serper = calls.filter((c) => c.url.includes("serper"));
    assert.ok(serper.length <= 4);
    assert.ok(serper.some((c) => c.body?.gl === "se"));
  });

  it("answers with no findings when there is no Serper key", async () => {
    const { deps, calls } = makeDeps(async () => json({}));
    const report = await runMarketLive(deps, testConfig({ serperKey: null }), plan(), { budgetMs: 2000, rates: FALLBACK_RATES });
    assert.equal(report.stopReason, "no_searches");
    assert.equal(report.findings.length, 0);
    assert.equal(calls.filter((c) => c.url.includes("serper")).length, 0);
  });

  it("survives a failing search", async () => {
    const { deps } = makeDeps(async (call) => (String(call.body?.q) === "query s1" ? json({ error: "x" }, 500) : serperSold(2, 50, "q")));
    const report = await runMarketLive(deps, testConfig(), plan(2), { budgetMs: 2000, rates: FALLBACK_RATES });
    assert.equal(report.outcomes.find((o) => o.search.id === "s1")?.failed, true);
    assert.ok(report.findings.length >= 1);
  });
});
