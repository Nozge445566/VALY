import type { AuthenticityReport, BrainInput, BrainRun, ConnectorLogRow, DetailReport, Finding, Fingerprint, Identification, JudgeVerdict, MarketReport, SearchLogRow, SearchPlan } from "../types.ts";
import { type BrainConfig, type Deps } from "../config.ts";
import type { ConnectorRecord } from "../connector.ts";
import type { MarketState } from "../present.ts";
import type { NeighbourRow } from "../neighbour-prior.ts";
import type { RunOptions } from "./options.ts";
import type { Settled } from "./async.ts";
import { FINISH_RESERVE_MS } from "./timing.ts";
import type { StoredValuation } from "../memory.ts";
import { estimateVerdict, mergeEyeFacts, neighbourEstimateVerdict } from "../anchor.ts";
import { neighbourSource } from "../neighbour-prior.ts";
import { buildConnectorLog, buildSearchLog } from "./logs.ts";
import { BRAIN_VERSION } from "../config.ts";
import { haikuWeightFor } from "../../_shared/connector-learn.ts";

/** What Memory found: a HIT (straight to the Judge) or a one-grade-off JUDGE. `hitFallback` is the old stored answer, used only if the Judge cannot answer in time. */
export type SoftStored = { stored: StoredValuation; ageDays: number; maxAgeDays: number; hit: boolean; hitFallback: (() => BrainRun) | null };

/** A stage returns null to continue, or the finished BrainRun to stop early. */
export type StageResult = BrainRun | null;

/**
 * Everything the stages share. Created once at the top of runBrainCore.
 * The collections (degraded, steps, marks) are mutated in place and never replaced.
 * Fields marked "set by" are assigned by that stage and only read by later ones.
 */
export interface RunState {
  readonly input: BrainInput;
  readonly cfg: BrainConfig;
  readonly deps: Deps;
  readonly opts: RunOptions;
  readonly elapsed: () => number;
  readonly judgeEnd: number;
  readonly degraded: string[];
  readonly steps: Record<string, unknown>;
  readonly marks: Record<string, number>;
  readonly identAbort: AbortController;
  readonly detailAbort: AbortController;
  readonly authAbort: AbortController;

  // set by eyes (detailState and authState are written later, by the promises' own callbacks)
  detailState: Settled<DetailReport> | null;
  authState: Settled<AuthenticityReport> | null;
  detailP: Promise<Settled<DetailReport>>;
  authP: Promise<Settled<AuthenticityReport>>;
  ident: Identification | null;
  fp: Fingerprint | null;
  key: string | null;
  neighboursP: Promise<NeighbourRow[] | null>;

  // set by memory
  softStored: SoftStored | null;

  // set by market
  plan: SearchPlan | null;
  connectorRecord: ConnectorRecord | null;
  report: MarketReport | null;
  marketState: MarketState;
  findings: Finding[];

  // set by judge
  details: DetailReport | null;
  authenticity: AuthenticityReport | null;
  verdict: JudgeVerdict | null;
  judgeRan: boolean;
  estimateMode: boolean;
}

export function createRunState(input: BrainInput, cfg: BrainConfig, deps: Deps, opts: RunOptions): RunState {
  const started = opts.startedAt ?? deps.now();
  return {
    input,
    cfg,
    deps,
    opts,
    elapsed: () => deps.now() - started,
    judgeEnd: cfg.answerMs - FINISH_RESERVE_MS,
    degraded: [],
    steps: {},
    marks: {},
    identAbort: new AbortController(),
    detailAbort: new AbortController(),
    authAbort: new AbortController(),
    detailState: null,
    authState: null,
    // placeholders only: the eyes stage replaces all of these before any other code reads them
    detailP: Promise.resolve({ ok: false, error: null }),
    authP: Promise.resolve({ ok: false, error: null }),
    ident: null,
    fp: null,
    key: null,
    neighboursP: Promise.resolve(null),
    softStored: null,
    plan: null,
    connectorRecord: null,
    report: null,
    marketState: "disabled",
    findings: [],
    details: null,
    authenticity: null,
    verdict: null,
    judgeRan: false,
    estimateMode: false,
  };
}

/** The learner's logs for this run (search log, and the Connector's own log when it ran). `verdict` is the Judge verdict as it stands at the call. */
export function logsFor(rs: RunState, verdict: JudgeVerdict): { searchLog: SearchLogRow[]; connectorLog: ConnectorLogRow | null } {
  const { plan, report, fp, connectorRecord, judgeRan, cfg, opts } = rs;
  if (!(plan && report && fp)) return { searchLog: [], connectorLog: null };
  const originals = connectorRecord ? new Map(connectorRecord.searches.map((r) => [r.id, r.original_query])) : undefined;
  const searchLog = buildSearchLog(plan, report, fp, judgeRan ? verdict : null, cfg.searchCostUsd, originals);
  const connectorLog = connectorRecord ? buildConnectorLog(connectorRecord, searchLog, report, fp, BRAIN_VERSION, haikuWeightFor(opts.connectorPolicy?.(), connectorRecord.bucket)) : null;
  return { searchLog, connectorLog };
}

/** Estimate ladder: rung 1-2 the anchor (Identification facts), rung 4 the neighbour prior; null = nothing usable. */
export async function estimateLadder(rs: RunState) {
  const { ident, authenticity, details, input, deps, steps, degraded, neighboursP } = rs;
  if (!ident) return null;
  const viaAnchor = estimateVerdict(mergeEyeFacts(ident, authenticity), details, input.lang);
  if (viaAnchor) return viaAnchor;
  const nb = neighbourSource((await neighboursP) ?? [], deps.now());
  const viaNb = neighbourEstimateVerdict(ident, details, nb, input.lang);
  if (viaNb && nb) { steps.neighbours = { n: nb.n, mid: Math.round(Math.exp(nb.mu)), sd: Math.round(nb.sd * 1000) / 1000, usedAsEstimate: true }; degraded.push("neighbour_estimate"); }
  return viaNb;
}
