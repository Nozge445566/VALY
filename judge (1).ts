import { type AuthenticityReport, type BrainResult, type BrainRun, type DetailReport, type JudgeVerdict, StepError } from "../../types.ts";
import { HARD_CAPS } from "../../config.ts";
import { DETAIL_GRACE_MS, JUDGE_A_GRACE_MS, JUDGE_MIN_MS } from "../timing.ts";
import { checkResult, EMPTY_EVIDENCE } from "../../check.ts";
import { type JudgeAReport } from "../../judge-a.ts";
import { errText, raceTimeout, type Settled } from "../async.ts";
import { ageDecay } from "../../memory.ts";
import { labelsOf, T } from "../../lang.ts";
import { emergencyVerdict, needsPhotoResult } from "../assemble.ts";
import { riskFromFlag } from "../helpers.ts";
import { judge, pickEffort } from "../../judge.ts";
import { estimateLadder, type RunState } from "../state.ts";

/** The Judge: photo + details + findings, then the fallbacks (stored answer, emergency verdict, estimate ladder). Sets verdict, judgeRan and estimateMode on the state. */
export async function judgeStage(rs: RunState): Promise<BrainRun | null> {
  const { input, cfg, deps, degraded, steps, marks, elapsed, judgeEnd } = rs;
  const { ident, fp, judgeAP, detailP, authP, detailAbort, authAbort, report } = rs;

  // Detail eye -> Judge (and the eye search). If it is still working, give it a short moment.
  const { findings, softStored } = rs;
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
  // Judge-A -> Judge: both are Haiku and fast; give Judge-A a short moment to finish so its labels reach the Judge. Late = missing.
  // Only while the Judge keeps its minimum time. These waits (DETAIL_GRACE_MS 250 ms for the Detail eye, 250 ms for the Authenticity eye
  // and JUDGE_A_GRACE_MS 400 ms for Judge-A, up to 0.9 s in total) all happen BEFORE judgeMs is calculated, so they are taken out of the
  // Judge's time. The 7 s limit does not move, but the Judge gets less time.
  if (rs.judgeASeen === null && judgeEnd - elapsed() - JUDGE_A_GRACE_MS >= JUDGE_MIN_MS) await raceTimeout(judgeAP, JUDGE_A_GRACE_MS);
  const judgeMs = judgeEnd - elapsed();
  if (judgeMs >= JUDGE_MIN_MS) {
    const judgeALabels = rs.judgeASeen as JudgeAReport | null;
    // How hard the Judge thinks (JUDGE_EFFORT=auto): chosen here, by code, from what is already known. No extra model call, no waiting
    // (Judge-A is only peeked at). Identification is used for this choice only: the Judge never receives it.
    const effortPick = pickEffort(cfg.judgeEffort, {
      ident,
      authenticity,
      judgeA: rs.judgeASeen as JudgeAReport | null,
      findings,
      memoryHit: softStored !== null && softStored.hit,
      memoryAgeDays: softStored ? softStored.ageDays : null,
      memoryMaxAgeDays: softStored ? softStored.maxAgeDays : null,
    });
    const effortLog = { effort: effortPick.effort, effortAuto: effortPick.auto, effortReasons: effortPick.reasons };
    deps.log("[Judge] start", { judgeMs, startedAtMs: elapsed(), ...effortLog });
    try {
      const outcome = await judge(deps, cfg, input, ident, details, findings, stats, judgeMs, softStored ? softStored.ageDays : null, authenticity, effortPick.effort, judgeALabels);
      verdict = outcome.verdict;
      if (outcome.partial) degraded.push("judge_partial");
      steps.judgeMs = outcome.ms;
      steps.judgeTrace = { ...effortLog, partial: outcome.partial, ...outcome.trace };
    } catch (e) {
      degraded.push("judge_failed");
      steps.judgeTrace = { ...effortLog, failed: true };
      deps.log("judge failed", errText(e));
    }
  } else {
    degraded.push("judge_no_time");
  }
  marks.judge = elapsed();
  steps.judge = verdict ?? { failed: true };

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
    // Emergency answer from raw listing prices, only when there is real data behind it.
    verdict = emergencyVerdict(ident, details, findings, input.lang);
    if (verdict) degraded.push("judge_emergency");
  }
  // No market data (no listings, Serper down, Judge cut before the ads): estimate from the eyes + Identification, never needs_photo first.
  let estimateMode = false;
  if (!verdict && ident && !findings.some((f) => f.priceUsd > 0)) {
    const est = await estimateLadder(rs);
    if (est) {
      verdict = est.verdict;
      estimateMode = true;
      degraded.push("no_market_estimate");
    } else if (ident.identifiable && judgeRan) {
      degraded.push("no_market_no_anchor");
      steps.timing = { ...marks, end: elapsed() };
      return { result: needsPhotoResult(ident, degraded, input.lang, T(input.lang).estimate.noAnchor), memoryHit: false, fingerprint: fp, saveable: false, memoryEligible: false, memoryRunId: null, steps, searchLog: [], connectorLog: null } as never;
    }
  }
  if (!verdict) throw new StepError("judge", "no answer could be made in time", degraded);
  rs.verdict = verdict;
  rs.judgeRan = judgeRan;
  rs.estimateMode = estimateMode;
  return null;
}
