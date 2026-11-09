import type { ConnectorLogRow, Fingerprint, JudgeVerdict, MarketReport, SearchLogRow, SearchPlan } from "../types.ts";
import { type ConnectorRecord, HAIKU_LINK_WEIGHT } from "../connector.ts";
import { type RewardSearch, rewardOf } from "../../_shared/connector-learn.ts";
import { tierOf } from "../market-tiers.ts";

function siteOfQuery(query: string): string | null {
  const m = /\bsite:([a-z0-9.-]+\.[a-z]{2,}(?:\/[a-z]+)?)/i.exec(query);
  return m ? m[1].toLowerCase() : null;
}

/** One row per search for the nightly learner. Item fingerprints only: no photo, no user data. */
export function buildSearchLog(
  plan: SearchPlan,
  report: MarketReport,
  fp: Fingerprint,
  verdict: JudgeVerdict | null,
  costUsd: number,
  /**
   * Connector: search id -> the ORIGINAL query. `query` always holds the plan's own query, `executed_query` what really ran,
   * and `connector_modified` says whether they differ. The Search AI skips modified rows when it credits a template (their
   * prices belong to the edit, not to the template); the Connector judges the edit from its own log (l_connector_log).
   */
  originalQueries?: ReadonlyMap<string, string>,
): SearchLogRow[] {
  const same = new Set(verdict?.same ?? []);
  const similar = new Set(verdict?.similar ?? []);
  return report.outcomes.map((o) => {
    const mine = report.findings.filter((f) => f.searchId === o.search.id);
    const prices = mine.map((f) => ({
      usd: f.priceUsd,
      kind: f.kind,
      verdict: same.has(f.id) ? ("same" as const) : similar.has(f.id) ? ("similar" as const) : ("different" as const),
    }));
    const keptSold = prices.filter((p) => p.verdict === "same" && p.kind === "sold").length;
    const keptAsking = prices.filter((p) => p.verdict === "same" && p.kind === "asking").length;
    const discarded = prices.filter((p) => p.verdict === "different").length;
    const planned = originalQueries?.get(o.search.id) ?? o.search.query;
    return {
      strategy_version: plan.strategyVersion,
      source: plan.source,
      fingerprint: fp,
      query: planned,
      executed_query: o.search.query,
      connector_modified: o.search.query.trim().toLowerCase() !== planned.trim().toLowerCase(),
      template_id: o.search.template_id,
      kind: o.search.kind,
      gl: o.search.gl,
      hl: o.search.hl,
      tier: tierOf(o.search.gl, fp.country),
      site: siteOfQuery(planned) ?? (mine[0]?.site ?? null),
      result_count: o.resultCount,
      sold_count: o.soldCount,
      kept_sold: verdict ? keptSold : 0,
      kept_asking: verdict ? keptAsking : 0,
      discarded: verdict ? discarded : 0,
      prices: prices.slice(0, 10),
      // Race-free credit: the search's OWN sold prices (USD numbers only, no keys), also those another search delivered
      // first. null = not recorded (failed or cancelled search). `prices` above keeps its exact old meaning.
      own_sold: o.ownSold ? o.ownSold.map((x) => x.usd) : null,
      latency_ms: Math.round(o.latencyMs),
      cost_usd: costUsd,
      cancelled: o.cancelled,
      stop_reason: report.stopReason,
      judge_ok: verdict !== null,
    };
  });
}

export function buildConnectorLog(
  record: ConnectorRecord,
  searchLog: SearchLogRow[],
  report: MarketReport,
  fp: Fingerprint,
  brainVersion: string,
  /** The Haiku weight that applies to this bucket (learned, or the prior of 1.375). Haiku's search counts this many times; the others once. */
  haikuWeight: number = HAIKU_LINK_WEIGHT,
): ConnectorLogRow {
  const byId = new Map(record.searches.map((r) => [r.id, r]));
  const searches = report.outcomes
    .map((o, i) => ({ o, row: searchLog[i], rec: byId.get(o.search.id) }))
    .filter((x) => x.rec !== undefined)
    .map(({ o, row, rec }) => ({
      id: o.search.id,
      template_id: rec!.template_id,
      original_query: rec!.original_query,
      proposed_query: rec!.proposed_query,
      executed_query: rec!.executed_query,
      rule: rec!.rule,
      role: rec!.role,
      rule_on: rec!.rule_on,
      rule_draw: rec!.rule_draw,
      rule_dial: rec!.rule_dial,
      rule_share: rec!.rule_share,
      skipped: rec!.skipped,
      is_haiku: rec!.is_haiku,
      weight: rec!.is_haiku ? haikuWeight : 1,
      result_count: o.resultCount,
      sold_count: o.soldCount,
      kept_sold: row?.kept_sold ?? 0, // legacy, no longer used for learning
      discarded: row?.discarded ?? 0, // legacy, no longer used for learning
      // Reward v2: sold prices (Market Live only, no Judge) and latency are what the Connector learns from.
      // When Market Live recorded the search's OWN sold prices (`ownSold`, before the first-come duplicate filter) those are
      // used, so a search is credited for a listing it found even if another search delivered it a moment earlier.
      // `price_keys` (same order) lets the learner count one listing once when it pools prices. Without `ownSold`
      // (older behaviour) the prices come from the findings as before and there are no keys.
      prices: o.ownSold ? o.ownSold.map((x) => x.usd) : (row?.prices ?? []).filter((x) => x.kind === "sold").slice(0, 5).map((x) => x.usd),
      ...(o.ownSold && o.ownSold.every((x) => typeof x.key === "string") ? { price_keys: o.ownSold.map((x) => x.key as string) } : {}),
      latency_ms: row?.latency_ms ?? Math.round(o.latencyMs),
      cancelled: o.cancelled,
      failed: o.failed,
      hit_keys: o.hitKeys ?? [], // E2: salted link hashes, comparable only inside this valuation
    }));
  const judgeOk = searchLog.length > 0 && searchLog.every((r) => r.judge_ok);
  return {
    run_id: null,
    brain_version: brainVersion,
    mode: record.mode,
    applied: record.applied,
    control: record.control,
    held_back: record.held_back,
    draw: record.draw,
    share: record.share,
    effective_share: record.effective_share,
    dial: record.dial,
    bucket: record.bucket,
    source: record.source,
    strategy_version: record.strategy_version,
    fingerprint: fp,
    haiku_query: record.haiku_query,
    local_name: record.local_name,
    proposed_changes: record.proposed_changes,
    searches,
    judge_ok: judgeOk,
    reward: judgeOk ? rewardOf(searches as unknown as RewardSearch[]) : null,
  };
}
