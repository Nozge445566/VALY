import { type ConnectorRuleId, HAIKU_LINK_WEIGHT as HAIKU_PRIOR } from "../../_shared/connector-learn.ts";
import type { Fingerprint, SearchPlan } from "../types.ts";


/** The three kinds of search the Connector tells apart: Haiku's own, the local templates, the global templates. */
export type SearchRole = "haiku" | "local" | "global";
/** Which rule calibrates which kind of search. A rule only ever touches searches of its own kind. */
export const RULE_ROLE: Readonly<Record<ConnectorRuleId, SearchRole>> = { R1: "local", RG: "global", RH: "haiku" };
export const RULE_OF_ROLE: Readonly<Record<SearchRole, ConnectorRuleId>> = { local: "R1", global: "RG", haiku: "RH" };
/** The rules that may act when the caller names none (the app always passes all three). */
export const DEFAULT_ACTIVE_RULES: readonly ConnectorRuleId[] = ["R1"];

/** Languages written without spaces between words: the word removal below cannot work there, so R1 stays quiet. */
export const NO_SPACE_LANGUAGES = new Set(["ja", "zh", "th", "lo", "km", "my"]);

/** Local name: 1 to 4 words. */
export const LOCAL_NAME_MAX_WORDS = 4;

/** Haiku's link counts this many times more than each of the other three when the learner scores a valuation. An assumption, not measured. */
export const HAIKU_LINK_WEIGHT = HAIKU_PRIOR;

export interface ConnectorSearchRecord {
  id: string;
  template_id: string;
  original_query: string;
  /** What R1 proposes. Equal to original_query when nothing is proposed. */
  proposed_query: string;
  /** What really went to Serper: the proposal when the Connector was applied, else the original. */
  executed_query: string;
  /** Which rule proposed a change, or null. */
  rule: ConnectorRuleId | null;
  /** Which kind of search this is. */
  role: SearchRole;
  /** The rule's own decision for this valuation (only when a rule proposed something): was it allowed to act, its draw, dial and share. */
  rule_on: boolean | null;
  rule_draw: number | null;
  rule_dial: number | null;
  rule_share: number | null;
  /** Why nothing was proposed for this search (short code), or null when something was. */
  skipped: string | null;
  /** True for Haiku's own search (the thick link). Edited only by rule RH. */
  is_haiku: boolean;
}

export interface ConnectorRecord {
  /** Always "on" (the Connector has no other mode). Kept as a field because it is a column in l_connector_log. */
  mode: "on";
  /** True only when the plan that ran was changed. */
  applied: boolean;
  /** Something was proposed, and the plan was NOT changed: the unmodified control group. */
  control: boolean;
  /** Part of the control group because the learned dial lowered the treated share (not because of the user's share). */
  held_back: boolean;
  /** The random number that decided it (uniform 0..1). Logged, so the decision can be replayed. */
  draw: number;
  share: number;
  /** The share that really applied after the learned dial. */
  effective_share: number;
  dial: number | null;
  bucket: string;
  source: "search_ai" | "fixed";
  strategy_version: number | null;
  haiku_query: string | null;
  local_name: string | null;
  proposed_changes: number;
  searches: ConnectorSearchRecord[];
}

export interface ConnectorContext {
  fingerprint: Fingerprint;
  /** Identification's Google queries (exactly one). Taken from the pipeline, not from the plan. */
  haikuQueries: readonly string[];
  /** Share of valuations that may get the change, and the lowest share the dial may push it to. */
  share: number;
  minShare: number;
  /** Uniform random number in [0,1), made by the caller so that it can be logged and replayed. */
  draw: number;
  /** The learned dial (0..1) for this bucket, or null when nothing is learned yet. This is rule R1's dial. */
  dial: number | null;
  /** The rules allowed to act (the app passes all three). */
  rules?: readonly ConnectorRuleId[];
  /** One independent random draw per rule (so each rule has its own control group). Missing = `draw`. */
  draws?: Partial<Record<ConnectorRuleId, number>>;
  /** The learned dial per rule. Missing = R1 gets `dial`, the others none. */
  dials?: Partial<Record<ConnectorRuleId, number | null>>;
}

export interface ConnectorOutcome {
  /** The plan Market Live must run. The very same object as the input unless the Connector was applied. */
  plan: SearchPlan;
  /** Null when the Connector failed (then the original plan runs). */
  record: ConnectorRecord | null;
}
