import { type AuthenticityReport, type BrainRun, type DetailReport, type MarketReport, type PlannedSearch, type SearchPlan } from "../../types.ts";
import { HARD_CAPS } from "../../config.ts";
import { applyConnector, connectorBucket, type ConnectorRecord, type ConnectorRuleId, dialFor } from "../../connector.ts";
import { SEARCH_MIN_MS } from "../timing.ts";
import { type MarketState } from "../../present.ts";
import { errText, raceTimeout, type Settled } from "../async.ts";
import { storedAsFindings } from "../../memory.ts";
import { policyKey } from "../../../_shared/connector-learn.ts";
import { planSearches } from "../../search-ai.ts";
import { productionSourceBeliefs } from "../../../_shared/search-ai/local-engine.ts";
import { runMarketLive } from "../../market-live.ts";
import { withEyeSearch } from "../eye-search.ts";
import type { RunState } from "../state.ts";

/** MISS: Market Live <-> Search AI (contains the Connector hook, unchanged). Sets plan, connectorRecord, report, marketState and findings on the state. */
export async function marketStage(rs: RunState): Promise<BrainRun | null> {
  const { cfg, deps, opts, degraded, steps, marks, elapsed, judgeEnd } = rs;
  const { ident, fp, detailP, authP } = rs;

  let plan: SearchPlan | null = null;
  let connectorRecord: ConnectorRecord | null = null;
  let report: MarketReport | null = null;
  let marketState: MarketState = "disabled";

  const softStored = rs.softStored;
  if (softStored) {
    // No new search: the Judge reads the listings saved with the earlier valuation (marked as such, with their age).
    marketState = "memory";
    steps.search = { fromMemory: softStored.stored.runId, ageDays: Math.round(softStored.ageDays * 10) / 10 };
    marks.market = elapsed();
  } else if (ident && fp) {
    const fx = await opts.fx;
    const planned = await planSearches(deps, cfg, fp, ident.google_queries, opts.localPlan);
    plan = planned.plan;
    if (planned.fallbackReason) degraded.push(planned.fallbackReason);
    // CONNECTOR: the one hook, right after planSearches because Haiku's query lives in this scope. Pure and synchronous: no network, no waiting.
    const policy = opts.connectorPolicy?.();
    const bucket = connectorBucket(fp, plan.source);
    const rd = opts.connectorDraw ?? Math.random;
    // One independent draw and one learned dial per rule: each of the four searches is calibrated on its own terms.
    const draws: Partial<Record<ConnectorRuleId, number>> = { R1: rd(), RG: rd(), RH: rd() };
    const dials: Partial<Record<ConnectorRuleId, number | null>> = {
      R1: dialFor(policy, policyKey("R1", bucket)),
      RG: dialFor(policy, policyKey("RG", bucket)),
      RH: dialFor(policy, policyKey("RH", bucket)),
    };
    const c = applyConnector(plan, {
      fingerprint: fp,
      haikuQueries: ident.google_queries,
      share: cfg.connectorShare,
      minShare: cfg.connectorMinShare,
      draw: draws.R1 as number,
      dial: dials.R1 ?? null,
      rules: cfg.connectorRules,
      draws,
      dials,
    });
    plan = c.plan;
    connectorRecord = c.record;
    if (c.record) {
      steps.connector = { mode: c.record.mode, applied: c.record.applied, control: c.record.control, changes: c.record.proposed_changes, bucket: c.record.bucket };
    }
    // Detail eye + Authenticity eye -> Market Live (diagram). LATE LAUNCH: the planned searches start at once and nothing waits for
    // the eyes here. The mandatory eye-evidence search (one extra search carrying what the eyes could read: a hallmark, a serial,
    // an era) is built as soon as both eyes have delivered, or when the eyes' deadline (cfg.eyesMs from the start) passes, and is
    // launched inside Market Live on its own. Built from the plan AFTER the Connector so it never confuses it; kept out of the Connector record.
    const basePlan = plan as SearchPlan;
    const eyeLaunch: { search: PlannedSearch | null; atMs: number | null; skipped: boolean } = { search: null, atMs: null, skipped: false };
    const lateExtra: Promise<PlannedSearch | null> = (async () => {
      try {
        if (rs.detailState === null || rs.authState === null) await raceTimeout(Promise.all([detailP, authP]), Math.max(0, cfg.eyesMs - elapsed()));
        const ds0 = rs.detailState as Settled<DetailReport> | null;
        const as0 = rs.authState as Settled<AuthenticityReport> | null;
        const withEye = withEyeSearch(basePlan, ds0 && ds0.ok ? ds0.value : null, as0 && as0.ok ? as0.value : null);
        const added = (withEye.extraSearches?.length ?? 0) > (basePlan.extraSearches?.length ?? 0);
        const extra = added ? withEye.extraSearches![withEye.extraSearches!.length - 1] : null;
        eyeLaunch.skipped = !added && basePlan.searches.length > 0; // the eyes read nothing new: no duplicate search is bought
        eyeLaunch.search = extra && extra.template_id === "eyes_evidence" ? extra : null;
        eyeLaunch.atMs = elapsed();
        return eyeLaunch.search;
      } catch (e) {
        deps.log("eye search could not be built", errText(e));
        return null;
      }
    })();
    marks.plan = elapsed();

    // The search is shortened so that the Judge keeps its time. The Judge is the most important step.
    const budget = judgeEnd - elapsed() - cfg.judgeTargetMs;
    if (!cfg.serperKey) {
      degraded.push("market_not_configured");
      marketState = "disabled";
    } else if (budget < SEARCH_MIN_MS) {
      degraded.push("market_skipped");
      marketState = "failed";
    } else {
      try {
        report = await runMarketLive(deps, cfg, plan, {
          budgetMs: budget,
          rates: fx.rates,
          fingerprint: fp,
          learnedSoldPerSearch: opts.learnedSoldPerSearch?.(),
          collectHitKeys: true, // E2: overlap data for the Connector's own log
          lateExtra,
          sourceBeliefs: opts.sourceBeliefs ?? productionSourceBeliefs(),
        });
        marketState =
          report.findings.length === 0
            ? report.outcomes.every((o) => o.failed) ? "failed" : "empty"
            : report.effectiveSold >= HARD_CAPS.soldPrices ? "ok" : "thin";
        if (report.effectiveSold < HARD_CAPS.soldPrices) degraded.push("market_thin");
        if (report.tiersUsed.includes("regional")) degraded.push("market_regional");
        if (report.tiersUsed.includes("global") && fp.country !== "ZZ") degraded.push("market_global");
        if (fx.source === "fallback") degraded.push("fx_fallback");
      } catch (e) {
        degraded.push("market_failed");
        marketState = "failed";
        deps.log("market live failed", errText(e));
      }
    }
    marks.market = elapsed();
    // What the eyes added is logged and shown in the plan exactly as before (the extra search is the last of extraSearches).
    const launchedEye = report?.outcomes.some((o) => o.search.template_id === "eyes_evidence") ? eyeLaunch.search : null;
    if (launchedEye) plan = { ...(plan as SearchPlan), extraSearches: [...((plan as SearchPlan).extraSearches ?? []), launchedEye] };
    steps.eyeSearch = { reason: launchedEye?.reason ?? (eyeLaunch.search ? "not_launched" : eyeLaunch.skipped ? "no_new_terms" : "none"), builtAtMs: eyeLaunch.atMs, replaced: report?.eyeSearch?.replaced ?? null, ran: report?.eyeSearch?.ran ?? false, why: report?.eyeSearch?.reason ?? null };
    steps.search = {
      plan,
      stopReason: report?.stopReason ?? null,
      soldCount: report?.soldCount ?? 0,
      effectiveSold: report ? Math.round(report.effectiveSold * 100) / 100 : 0,
      tiersUsed: report?.tiersUsed ?? null,
      outcomes: report?.outcomes.map((o) => ({
        id: o.search.id,
        query: o.search.query,
        gl: o.search.gl,
        tier: o.search.tier ?? null,
        results: o.resultCount,
        sold: o.soldCount,
        ms: Math.round(o.latencyMs),
        cancelled: o.cancelled,
        failed: o.failed,
      })),
      dropped: report?.droppedCount ?? 0,
    };
  } else {
    degraded.push("market_skipped");
    marketState = "failed";
  }
  const findings = softStored ? storedAsFindings(softStored.stored) : (report?.findings ?? []);
  rs.plan = plan;
  rs.connectorRecord = connectorRecord;
  rs.report = report;
  rs.marketState = marketState;
  rs.findings = findings;
  return null;
}
