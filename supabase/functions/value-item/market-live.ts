// Market Live: Google via Serper. It runs the searches the Search AI chose, in parallel.
// Code (not AI) extracts the price from the hits, and the findings go to the Judge.
//
// The stopper lives here: "all 4 run in parallel, stop at 5 sold prices or 2.0 s, cancel the rest."
// The limits come from the Search AI's plan but are clamped to the hard caps in config.ts.

import { HARD_CAPS } from "./config.ts";
import type { Deps, BrainConfig } from "./config.ts";
import { convertCurrency } from "./fx.ts";
import { AbortedError, postJson } from "./http.ts";
import { escalationSearches, effectiveSold, findingCountry, isThinData, nextTiers, tierOf } from "./market-tiers.ts";
import type { Tier } from "./market-tiers.ts";
import { extractMoney, hostOf, listingKind } from "./money.ts";
import type { Finding, Fingerprint, MarketReport, PlannedSearch, SearchOutcome, SearchPlan, StopReason } from "./types.ts";
import { clean, normalizeUrl } from "./validate.ts";
import { analyzeFindings } from "./select-ads.ts";
import { keepRelevant } from "./relevance.ts";
import type { SourceBeliefs } from "../_shared/search-ai/beliefs.ts";

const SERPER_URL = "https://google.serper.dev/search";
const UA = "ValyValuation/4.0";

export { MAX_FINDINGS, JUDGE_MAX_ADS, selectFindings, analyzeFindings } from "./select-ads.ts";

export interface RawHit {
  title: string;
  url: string;
  snippet: string;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Reads Serper's organic results. Attributes (when Google shows them) are added to the snippet. */
export function serperHits(data: unknown): RawHit[] {
  const organic = rec(data)?.organic;
  if (!Array.isArray(organic)) return [];
  const hits: RawHit[] = [];
  for (const row of organic) {
    const r = rec(row);
    if (!r) continue;
    const title = typeof r.title === "string" ? r.title : "";
    const url = typeof r.link === "string" ? r.link : "";
    let snippet = typeof r.snippet === "string" ? r.snippet : "";
    const attrs = rec(r.attributes);
    if (attrs) {
      const extra = Object.entries(attrs)
        .filter(([, v]) => typeof v === "string" || typeof v === "number")
        .map(([k, v]) => `${k}: ${v}`)
        .join(" ");
      snippet = `${snippet} ${extra}`.trim();
    }
    if (title && /^https?:\/\//i.test(url) && url.length <= 500) hits.push({ title, url, snippet });
  }
  return hits;
}

/** At most this many of a search's OWN sold prices are kept for the learners (both cap at 5 anyway). */
export const OWN_SOLD_MAX = 5;

/**
 * Turns raw hits into priced findings. A hit without a readable price is dropped, a link already
 * seen is dropped, and a currency we have no rate for is dropped. Nothing is ever invented.
 *
 * `ownSold` is a SECOND, separate answer for the learners (Search AI and Connector): every sold price this search returned itself,
 * including listings that another search had already delivered first (those are dropped from `findings` so the Judge
 * does not see a listing twice, but the search that also found them still found them). Credit for a search must not depend
 * on which of the parallel searches happened to answer a few milliseconds earlier. It is in the order Google ranked the hits,
 * has no duplicates inside the search, and is never used for the Judge's findings.
 */
export function hitsToFindings(
  hits: RawHit[],
  search: PlannedSearch,
  rates: Record<string, number>,
  seenUrls: Set<string>,
  /** The user's country. Decides the tier of every listing. Unknown or left out: everything is local. */
  country: string | null = null,
): { findings: Omit<Finding, "id">[]; dropped: number; ownSold: { url: string; usd: number }[] } {
  const findings: Omit<Finding, "id">[] = [];
  const ownSold: { url: string; usd: number }[] = [];
  const ownSeen = new Set<string>();
  let dropped = 0;
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    const already = seenUrls.has(key); // another search delivered this listing first
    const host = hostOf(hit.url);
    const origin = findingCountry(host, search.gl);
    const blob = `${hit.title} ${hit.snippet}`;
    const money = extractMoney(blob, { host, gl: search.gl });
    if (money.length === 0) {
      dropped++;
      continue;
    }
    const usd = convertCurrency(money[0].price, money[0].currency, "USD", rates);
    const title = clean(hit.title, 110);
    if (usd === null || !(usd > 0) || !title) {
      dropped++;
      continue;
    }
    const priceUsd = Math.round(usd * 100) / 100;
    const kind = listingKind(blob);
    // Own credit: counted whether or not another search was first, but once per listing inside this search.
    if (kind === "sold" && !ownSeen.has(key)) {
      ownSeen.add(key);
      ownSold.push({ url: hit.url, usd: priceUsd });
    }
    if (already) {
      dropped++;
      continue;
    }
    seenUrls.add(key);
    findings.push({
      searchId: search.id,
      title,
      snippet: clean(hit.snippet, 160),
      url: hit.url,
      site: host,
      kind,
      price: money[0].price,
      currency: money[0].currency,
      priceUsd,
      gl: search.gl,
      origin,
      tier: tierOf(origin, country),
    });
  }
  return { findings, dropped, ownSold };
}

/** E2 (overlap): at most this many link keys are kept per search. */
export const HIT_KEYS_MAX = 10;

/**
 * A short, salted fingerprint of one listing link (12 hex characters). Pure, synchronous, microseconds: it must never cost
 * the Judge any time. The salt is made new for every valuation, so two valuations can never be linked and a key cannot be
 * looked up from a known address: keys are only comparable INSIDE one valuation, which is all the overlap report needs.
 * Not cryptographic on purpose (nothing secret is protected): it is a label that says "the same listing".
 */
export function hitKeyOf(url: string, salt: string): string {
  const s = `${salt}|${normalizeUrl(url)}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0); // 53 bits
  return n.toString(16).padStart(14, "0").slice(-12);
}

async function serperSearch(
  deps: Deps,
  key: string,
  s: PlannedSearch,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RawHit[]> {
  const data = await postJson(
    deps,
    SERPER_URL,
    { "X-API-KEY": key, "User-Agent": UA },
    { q: s.query, gl: s.gl, hl: s.hl, num: 10 },
    { timeoutMs, retries: 0, signal },
  );
  return serperHits(data);
}

export interface MarketOptions {
  /** Time the pipeline can still spend on searching, in ms. */
  budgetMs: number;
  rates: Record<string, number>;
  /**
   * The item and the user's market. With it Market Live runs the country ladder (local, then
   * regional, then global) and tags every listing with its tier. Without it the plan runs as it
   * is and everything counts as local (the old behaviour).
   */
  fingerprint?: Fingerprint | null;
  /** Measured sold prices per local search, by country, from the learner. Overrides the starting list of thin countries. */
  learnedSoldPerSearch?: ReadonlyMap<string, number>;
  /**
   * E2 (overlap), report-only. When true, each outcome also carries `hitKeys` (salted hashes of the listing links the search
   * returned, before the duplicate filter). Left out or false: nothing is computed and the outcomes are exactly as before.
   */
  collectHitKeys?: boolean;
  /**
   * LATE LAUNCH: the planned searches start at once; this promise delivers the mandatory eye-evidence search as soon as
   * the eyes have delivered (or their deadline passed). It is launched on its own, never waits for the planned searches and is
   * skipped when the window is closed, the target is already reached or the cap is full. null = nothing to add.
   */
  lateExtra?: Promise<PlannedSearch | null>;
  /**
   * Search AI's learned trust per source. Used by the statistical ad selector (belief in, per-source inlier evidence out).
   * Left out: every source has the default prior and nothing is learned (the old behaviour).
   */
  sourceBeliefs?: SourceBeliefs;
}

/** An escalation wave is only worth starting when at least this much of the window is left. */
export const ESCALATE_MIN_MS = 450;

export async function runMarketLive(
  deps: Deps,
  cfg: BrainConfig,
  plan: SearchPlan,
  opts: MarketOptions,
): Promise<MarketReport> {
  const started = deps.now();
  const fp = opts.fingerprint ?? null;
  const country = fp && fp.country !== "ZZ" ? fp.country : null;
  const searches = [...plan.searches.slice(0, HARD_CAPS.searches), ...(plan.extraSearches ?? [])].slice(0, HARD_CAPS.searchesTotal);
  const windowMs = Math.max(
    0,
    Math.min(plan.stop.maxMs, cfg.searchMs, HARD_CAPS.searchMs, opts.budgetMs),
  );
  const target = Math.min(plan.stop.soldPrices, HARD_CAPS.soldPrices);

  if (!cfg.serperKey || searches.length === 0 || windowMs < 300) {
    return {
      findings: [],
      outcomes: searches.map((search) => ({
        search,
        resultCount: 0,
        soldCount: 0,
        latencyMs: 0,
        cancelled: false,
        failed: true,
      })),
      soldCount: 0,
      stopReason: "no_searches",
      elapsedMs: 0,
      droppedCount: 0,
      tiersUsed: ["local"],
      effectiveSold: 0,
    };
  }

  const master = new AbortController();
  let stopReason: StopReason | null = null;
  const all: Omit<Finding, "id">[] = [];
  const seenUrls = new Set<string>();
  let dropped = 0;
  const outcomes = new Map<PlannedSearch, SearchOutcome>();
  const ran: PlannedSearch[] = []; // in the order the searches were started
  const tiersUsed: Tier[] = ["local"];
  const hitSalt = opts.collectHitKeys ? Math.random().toString(36).slice(2, 12) : "";

  const timer = setTimeout(() => {
    if (!stopReason) {
      stopReason = "time";
      master.abort();
    }
  }, windowMs);

  /** Enough sold prices when they are counted by how well they speak for the user's country. */
  const enough = () => effectiveSold(all) >= target;

  const launch = async (search: PlannedSearch): Promise<void> => {
    const t0 = deps.now();
    const outcome: SearchOutcome = { search, resultCount: 0, soldCount: 0, latencyMs: 0, cancelled: false, failed: false };
    ran.push(search);
    outcomes.set(search, outcome);
    try {
      const hits = await serperSearch(deps, cfg.serperKey as string, search, windowMs + 100, master.signal);
      outcome.resultCount = hits.length;
      if (opts.collectHitKeys) {
        // Report-only and never allowed to hurt a search: any problem here simply leaves the keys out.
        try {
          outcome.hitKeys = [...new Set(hits.slice(0, HIT_KEYS_MAX).map((h) => hitKeyOf(h.url, hitSalt)))];
        } catch {
          // ignore
        }
      }
      const got = hitsToFindings(hits, search, opts.rates, seenUrls, country);
      // Race-free credit for both learners (see hitsToFindings). Always computed; report-only, a problem leaves it out.
      // The listing key is added only when the Connector asked for overlap data (collectHitKeys); the Search AI needs prices only.
      try {
        outcome.ownSold = got.ownSold
          .slice(0, OWN_SOLD_MAX)
          .map((x) => (opts.collectHitKeys ? { key: hitKeyOf(x.url, hitSalt), usd: x.usd } : { usd: x.usd }));
      } catch {
        // ignore
      }
      dropped += got.dropped;
      all.push(...got.findings);
      outcome.soldCount = got.findings.filter((f) => f.kind === "sold").length;
      if (enough() && !stopReason) {
        stopReason = "target";
        master.abort(); // cancel the searches that are still running
      }
    } catch (e) {
      if (e instanceof AbortedError || master.signal.aborted) outcome.cancelled = true;
      else {
        outcome.failed = true;
        deps.log("search failed", e instanceof Error ? e.message : String(e));
      }
    } finally {
      outcome.latencyMs = deps.now() - t0;
    }
  };

  // ---- Wave 1: what the Search AI (or the fixed templates) planned. For a country with thin data
  // one global search runs at the same time, so no time is lost waiting for the local ones to fail.
  const wave1 = [...searches];
  const used = new Set(wave1.map((s) => s.query.toLowerCase()));
  if (fp && isThinData(country, opts.learnedSoldPerSearch) && !wave1.some((s) => tierOf(s.gl, country) === "global")) {
    const extra = escalationSearches(fp, ["global"], used, wave1.length + 1);
    for (const e of extra) {
      wave1.push(e);
      used.add(e.query.toLowerCase());
    }
    if (extra.length > 0) tiersUsed.push("global");
  }
  const wave1Runs = wave1.slice(0, HARD_CAPS.searchesTotal).map(launch);
  // The late search joins as soon as it exists. A failure to deliver it simply means there is no extra search.
  await Promise.all(wave1Runs);
  // Authenticity eye -> Market Live: ONLY when the market is thin after the first wave (D1: effectiveSold < 5) and the eye has a concrete
  // query. It takes the place of the weakest of the Search-AI searches (lowest sold count, else the last of them); never Haiku's 4th.
  // (Owner D2: all Search-AI searches still run in wave 1, so the replaced search has already run; its slot is simply not extended.)
  let eyeInfo: MarketReport["eyeSearch"] = { ran: false, replaced: null, reason: opts.lateExtra ? "market_not_thin" : "no_eye_query" };
  if (opts.lateExtra && !stopReason && !master.signal.aborted && effectiveSold(all) < HARD_CAPS.soldPrices) {
    const late = await opts.lateExtra.catch(() => null);
    if (!late) eyeInfo = { ran: false, replaced: null, reason: "no_eye_query" };
    else if (stopReason || master.signal.aborted || ran.length >= HARD_CAPS.searchesTotal) eyeInfo = { ran: false, replaced: null, reason: "window_closed" };
    else {
      const aiThree = ran.slice(0, HARD_CAPS.searches).filter((s) => !(/^id_fixed_\d+$/.test(s.template_id) || s.template_id.startsWith("id:") || s.template_id.startsWith("idv:") || s.template_id === "eyes_evidence"));
      let weakest: PlannedSearch | null = null;
      for (const s of aiThree) {
        const o = outcomes.get(s);
        if (!weakest || (o?.soldCount ?? 0) <= (outcomes.get(weakest)?.soldCount ?? 0)) weakest = s; // ties: the later one is the weaker
      }
      used.add(late.query.toLowerCase());
      await launch(late);
      eyeInfo = { ran: true, replaced: weakest ? weakest.id : null, reason: "market_thin" };
    }
  }

  // ---- Later waves: regional, then global, only while the data is still too thin and time is left.
  while (fp && country && !stopReason && ran.length < HARD_CAPS.searchesTotal) {
    if (windowMs - (deps.now() - started) < ESCALATE_MIN_MS) break;
    const tiers = nextTiers(tiersUsed, effectiveSold(all));
    if (tiers.length === 0) break;
    const wave = escalationSearches(fp, tiers, used, ran.length + 1).slice(0, HARD_CAPS.searchesTotal - ran.length);
    for (const t of tiers) if (!tiersUsed.includes(t)) tiersUsed.push(t);
    if (wave.length === 0) continue; // nothing new to try in these tiers; the loop moves on to the next ones
    for (const w of wave) used.add(w.query.toLowerCase());
    await Promise.all(wave.map(launch));
  }
  clearTimeout(timer);

  // Search AI + the statistics choose the Judge's ads together: its beliefs go in, the selector's inlier evidence comes back.
  // A problem with the learner must never cost an answer, so a failing belief falls back to the default prior.
  const sb = opts.sourceBeliefs;
  // First drop hits that are not about the item (category pages, other products): the selector below only looks at prices.
  const relevant = keepRelevant(all, ran.map((s) => s.query));
  if (relevant.removed > 0) deps.log("[Market] off-topic hits removed", { removed: relevant.removed, kept: relevant.kept.length });
  const { chosen: findings, trace } = analyzeFindings(relevant.kept, {
    optimism: sb ? 0.5 : 0,
    belief: sb ? (f) => { try { return sb.belief(f); } catch { return undefined; } } : undefined,
  });
  if (sb) {
    try { sb.record(trace.sourceEvidence); } catch (e) { deps.log("source beliefs record failed", e instanceof Error ? e.message : String(e)); }
  }
  return {
    findings,
    outcomes: ran.map((s) => outcomes.get(s) as SearchOutcome),
    soldCount: findings.filter((f) => f.kind === "sold").length,
    stopReason: stopReason ?? "done",
    elapsedMs: deps.now() - started,
    droppedCount: dropped,
    tiersUsed,
    effectiveSold: effectiveSold(findings),
    eyeSearch: eyeInfo,
  };
}
