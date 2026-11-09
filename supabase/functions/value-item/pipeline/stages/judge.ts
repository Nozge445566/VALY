import { type AuthenticityReport, type BrainResult, type BrainRun, type DetailReport, type JudgeVerdict, StepError } from "../../types.ts";
import { HARD_CAPS } from "../../config.ts";
import { DETAIL_GRACE_MS } from "../timing.ts";
import { checkResult, EMPTY_EVIDENCE } from "../../check.ts";
import { errText, raceTimeout, type Settled } from "../async.ts";
import { ageDecay } from "../../memory.ts";
import { labelsOf, T } from "../../lang.ts";
import { needsPhotoResult } from "../assemble.ts";
import { riskFromFlag } from "../helpers.ts";
import { judge, pickEffort } from "../../judge.ts";
import { judgeMaxAds } from "../../select-ads.ts";
import { type RunState } from "../state.ts";

/** The Judge: photo + details + findings, then the fallbacks (stored answer). Sets verdict, judgeRan on the state. */
export async function judgeStage(rs: RunState): Promise<BrainRun | null> {
  const { input, cfg, deps, degraded, steps, marks, elapsed, judgeEnd } = rs;
  const { ident, fp, detailP, authP, detailAbort, authAbort, report } = rs;

  // Detail eye -> Judge (and the eye search). If it is still working, give it a short moment.
  // Market Live lists its best ads first (select-ads.ts): the Judge gets the first JUDGE_MAX_ADS, the rest stay on the state.
  const { softStored } = rs;
  const findings = rs.findings.slice(0, judgeMaxAds(judgeEnd - elapsed()));
  let details: DetailReport | null = null;
  if (rs.detailState === null) await raceTimeout(detailP, DETAIL_GRACE_MS);
  const ds = rs.detailState as Settled<DetailReport> | null;
  if (ds && ds.ok) details = ds.value;
  else {
    detailAbort.abort();
    degraded.push(ds && !ds.ok ? "detail_eye_failed" : "detail_eye_late");
  }
  steps.details = details ?? { missing: true };
  rs.details = details;

  const stats = {
    findingCount: findings.length,
    soldCount: softStored ? findings.filter((f) => f.kind === "sold").length : (report?.soldCount ?? 0),
    soldTarget: HARD_CAPS.soldPrices,
    stopReason: softStored ? "saved listings, not searched today" : (report?.stopReason ?? "no_searches"),
  };

  // Authenticity eye -> Judge. If it is still working, give it the same short moment.
  if (rs.authState === null) await raceTimeout(authP, DETAIL_GRACE_MS);
  const as1 = rs.authState as Settled<AuthenticityReport> | null;
  let authenticity: AuthenticityReport | null = null;
  if (as1 && as1.ok) authenticity = as1.value;
  else {
    authAbort.abort();
    degraded.push(as1 && !as1.ok ? "authenticity_eye_failed" : "authenticity_eye_late");
  }
  steps.authenticity = authenticity ?? { missing: true };
  rs.authenticity = authenticity;

  let verdict: JudgeVerdict | null = null;
  const judgeMs = judgeEnd - elapsed();
  {
    // How hard the Judge thinks (JUDGE_EFFORT=auto): chosen here, by code, from what is already known. No extra model call, no waiting.
    // Identification is used for this choice only: the Judge never receives it.
    const effortPick = pickEffort(cfg.judgeEffort, {
      ident,
      authenticity,
      findings,
      memoryHit: softStored !== null && softStored.hit,
      memoryAgeDays: softStored ? softStored.ageDays : null,
      memoryMaxAgeDays: softStored ? softStored.maxAgeDays : null,
      details,
    });
    const effortLog: Record<string, unknown> = { effort: effortPick.effort, effortAuto: effortPick.auto, effortReasons: effortPick.reasons };
    deps.log("[Judge] start", { judgeMs, startedAtMs: elapsed(), ...effortLog });
    try {
      const memAge = softStored ? softStored.ageDays : null;
      const outcome = await judge(deps, cfg, input, ident, details, findings, stats, judgeMs, memAge, authenticity, effortPick.effort);
      steps.memoryOutcome = softStored ? (softStored.hit ? "HIT" : "JUDGE") : "MISS";
      verdict = outcome.verdict;
      if (outcome.partial) degraded.push("judge_partial");
      steps.judgeMs = outcome.ms;
      steps.judgeTrace = { ...effortLog, judgeMs, adsSent: findings.length, partial: outcome.partial, ...outcome.trace };
    } catch (e) {
      degraded.push("judge_failed");
      steps.judgeTrace = { ...effortLog, failed: true };
      deps.log("judge failed", errText(e));
    }
  }
  marks.judge = elapsed();
  steps.judge = verdict ?? { failed: true };
  if (steps.memoryOutcome === undefined) steps.memoryOutcome = softStored ? (softStored.hit ? "HIT" : "JUDGE") : "MISS";

  const judgeRan = verdict !== null;
  if (!verdict && softStored && softStored.hitFallback) return softStored.hitFallback();
  if (!verdict && softStored) {
    // The Judge could not re-check the condition in time. The saved valuation is still the best honest answer, but it
    // was made for another condition, so it is shown as less sure and the person is told.
    degraded.push("memory_condition_unverified");
    const st = softStored.stored.result;
    const unsure: BrainResult = {
      ...st,
      fromMemory: true,
      degraded: [...degraded],
      confidenceScore: Math.min(40, Math.max(5, st.confidenceScore - ageDecay(softStored.ageDays, softStored.maxAgeDays))),
      factors: [
        ...st.factors.filter((f) => !labelsOf("memory").includes(f.label)),
        { label: T(input.lang).labels.memory, detail: T(input.lang).memoryUnverified },
      ],
    };
    steps.timing = { ...marks, end: elapsed() };
    return {
      result: checkResult(unsure, { ...EMPTY_EVIDENCE, fromMemory: true, judgeRan: false }, riskFromFlag(st.authenticityFlag), false, input.lang),
      memoryHit: true,
      fingerprint: fp,
      saveable: false,
      memoryEligible: false,
      memoryRunId: softStored.stored.runId,
      steps,
      searchLog: [],
    };
  }
  if (!verdict) {
    // T1: a Judge that ran out of time must never end in a 502. Worst case is HTTP 200 with needs_photo (never saved, never Memory).
    degraded.push(judgeRan || !ident ? "no_market_no_anchor" : "judge_cut_no_anchor");
    steps.timing = { ...marks, end: elapsed() };
    const msg = ident?.identifiable ? T(input.lang).estimate.noAnchor : T(input.lang).needsPhoto;
    return { result: needsPhotoResult(ident ?? null, degraded, input.lang, msg), memoryHit: false, fingerprint: fp, saveable: false, memoryEligible: false, memoryRunId: null, steps, searchLog: [], connectorLog: null } as never;
  }
  rs.verdict = verdict;
  rs.judgeRan = judgeRan;
  return null;
}
