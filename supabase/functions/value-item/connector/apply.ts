import { CONNECTOR_RULE_IDS, type ConnectorRuleId } from "../../_shared/connector-learn.ts";
import { type ConnectorContext, type ConnectorOutcome, type ConnectorRecord, DEFAULT_ACTIVE_RULES, RULE_OF_ROLE } from "./model.ts";
import { type Proposal, proposeR1, roleOf } from "./r1.ts";
import type { SearchPlan } from "../types.ts";
import { connectorBucket } from "./buckets.ts";
import { planKeepsRules } from "./invariants.ts";
import { proposeTidy } from "./tidy.ts";

// ---------------------------------------------------------------- the entry point

interface RuleDecision {
  draw: number;
  share: number;
  dial: number | null;
  effective: number;
  /** The rule is switched on. */
  allowed: boolean;
}

/**
 * The hook that runs right after planSearches. Pure and synchronous. On ANY error it returns the original plan (a broken Connector must never fail an answer).
 *
 * All three rules look at the ORIGINAL plan, and each only at its own kind of search, so they never fight over a query.
 * Each rule has its own draw and its own dial: it is applied when `draw < effective share`. The pieces are then put
 * together one rule at a time and every step is re-checked by planKeepsRules; a step that would break a rule is dropped.
 */
export function applyConnector(plan: SearchPlan, ctx: ConnectorContext): ConnectorOutcome {
  try {
    const fp = ctx.fingerprint;
    const share = Math.min(1, Math.max(0, ctx.share));
    const floor = Math.min(share, Math.min(0.5, Math.max(0, ctx.minShare)));
    const clampDraw = (d: number | undefined) => (typeof d === "number" && Number.isFinite(d) ? Math.min(0.999999, Math.max(0, d)) : 0.999999);
    const active = new Set(ctx.rules ?? DEFAULT_ACTIVE_RULES);

    const proposals: Record<ConnectorRuleId, Proposal> = {
      R1: proposeR1(plan, fp, ctx.haikuQueries),
      RG: proposeTidy(plan, fp, ctx.haikuQueries, "RG"),
      RH: proposeTidy(plan, fp, ctx.haikuQueries, "RH"),
    };

    const decide = (rule: ConnectorRuleId): RuleDecision => {
      const given = ctx.dials && rule in ctx.dials ? ctx.dials[rule] ?? null : rule === "R1" ? ctx.dial : null;
      const dial = given === null || given === undefined ? null : Math.min(1, Math.max(0, given));
      const effective = dial === null ? share : Math.min(share, Math.max(floor, share * dial));
      return { draw: clampDraw(ctx.draws?.[rule] ?? ctx.draw), share, dial, effective, allowed: active.has(rule) };
    };
    const decisions: Record<ConnectorRuleId, RuleDecision> = { R1: decide("R1"), RG: decide("RG"), RH: decide("RH") };

    // One record per search, taken from the rule that owns that kind of search.
    const owner = plan.searches.map((s) => RULE_OF_ROLE[roleOf(s, fp, ctx.haikuQueries)]);
    const records = plan.searches.map((s, i) => ({ ...proposals[owner[i]].records[i] }));
    const proposedQuery = plan.searches.map((s, i) => proposals[owner[i]].searches[i].query);

    // A rule counts as "proposed" when it owns at least one search whose record carries its id.
    const proposedBy = (rule: ConnectorRuleId) => records.map((r, i) => (owner[i] === rule && r.rule === rule ? i : -1)).filter((i) => i >= 0);
    const treated = new Set<ConnectorRuleId>();
    for (const rule of CONNECTOR_RULE_IDS) {
      const d = decisions[rule];
      if (proposedBy(rule).length > 0 && d.allowed && d.draw < d.effective) treated.add(rule);
    }

    // Build the plan that runs: one treated rule at a time, each step re-checked. A rejected step is dropped, never half applied.
    let running = plan.searches;
    const applied = new Set<ConnectorRuleId>();
    for (const rule of CONNECTOR_RULE_IDS) {
      if (!treated.has(rule)) continue;
      const idx = proposedBy(rule);
      const candidate = running.map((s, i) => (idx.includes(i) ? { ...s, query: proposedQuery[i] } : s));
      if (planKeepsRules(plan, { ...plan, searches: candidate })) {
        running = candidate;
        applied.add(rule);
      } else {
        for (const i of idx) {
          records[i].skipped = "invariant_failed";
          records[i].proposed_query = records[i].original_query;
          records[i].rule = null;
        }
      }
    }

    // Stamp every record with the decision of the rule that proposed it, and what really ran.
    records.forEach((r, i) => {
      const rule = owner[i];
      if (r.rule === rule) {
        const d = decisions[rule];
        r.rule_on = d.allowed;
        r.rule_draw = d.draw;
        r.rule_dial = d.dial;
        r.rule_share = d.effective;
      }
      r.executed_query = applied.has(rule) && r.rule === rule ? r.proposed_query : r.original_query;
    });

    const proposedTotal = records.filter((r) => r.rule !== null).length;
    const proposedAllowed = records.some((r) => r.rule !== null && r.rule_on === true);
    const primary: ConnectorRuleId = proposedBy("R1").length > 0 ? "R1" : (CONNECTOR_RULE_IDS.find((r) => proposedBy(r).length > 0) ?? "R1");
    const pd = decisions[primary];
    const anyApplied = applied.size > 0;
    const record: ConnectorRecord = {
      mode: "on",
      applied: anyApplied,
      control: proposedAllowed && !anyApplied,
      held_back: proposedAllowed && !anyApplied && pd.draw < pd.share,
      draw: pd.draw,
      share,
      effective_share: pd.effective,
      dial: pd.dial,
      bucket: connectorBucket(fp, plan.source),
      source: plan.source,
      strategy_version: plan.strategyVersion,
      haiku_query: proposals.R1.haikuQuery,
      local_name: proposals.R1.localName,
      proposed_changes: proposedTotal,
      searches: records,
    };
    if (!anyApplied) return { plan, record }; // control, or nothing to change: the plan is untouched
    return { plan: { ...plan, searches: running }, record };
  } catch {
    return { plan, record: null };
  }
}
