import { type BrainResult, type BrainRun, type DetailReport } from "../../types.ts";
import { MEMORY_TIMEOUT_MS, SEARCH_MIN_MS } from "../timing.ts";
import { checkResult, EMPTY_EVIDENCE } from "../../check.ts";
import { freshDetailFactors } from "../../present.ts";
import { errText, raceTimeout, type Settled, TIMED_OUT } from "../async.ts";
import { ageDecay, canLookInMemory, maxAgeDaysFor, memoryGate, selectStored, type StoredValuation } from "../../memory.ts";
import { labelsOf, T } from "../../lang.ts";
import { riskFromFlag } from "../helpers.ts";
import type { RunState } from "../state.ts";

/** Memory: do we recognize the item? Sets rs.softStored on a HIT or a one-grade-off JUDGE; never returns early. */
export async function memoryStage(rs: RunState): Promise<BrainRun | null> {
  const { input, cfg, deps, opts, degraded, steps, marks, elapsed, judgeEnd } = rs;
  const { ident, fp, key } = rs;
  const detailP = rs.detailP;

  // The Detail eye is never skipped. The look-up and the wait for the Detail eye run side by side, so Memory
  // costs no extra time when the Detail eye is on time (it started together with Identification).
  const detailNow = () => rs.detailState as Settled<DetailReport> | null;
  // `hit`: Memory recognised the item (diagram: TRAFF goes straight to the Judge). The saved ads go to the Judge with the
  // photo and the eyes; no Market Live. `hitFallback` is the old stored answer, used only if the Judge cannot answer in time.

  if (ident && fp && key && opts.memory && canLookInMemory(ident, cfg)) {
    const memory = opts.memory;
    let rows: StoredValuation[] = [];
    const lookup = (async () => {
      try {
        const got = await raceTimeout(memory.find(key, maxAgeDaysFor(cfg, ident.category) * 24 * 3600 * 1000), MEMORY_TIMEOUT_MS);
        if (got === TIMED_OUT) degraded.push("memory_slow");
        else rows = got;
      } catch (e) {
        degraded.push("memory_unavailable");
        deps.log("memory lookup failed", errText(e));
      }
    })();
    // Wait for the Detail eye, but never so long that the Brain could not still run in full after a MISS.
    const waitUntil = Math.min(cfg.memoryDetailWaitMs, judgeEnd - cfg.judgeTargetMs - SEARCH_MIN_MS);
    const detailWait = detailNow() === null ? raceTimeout(detailP, Math.max(0, waitUntil - elapsed())) : Promise.resolve(null);
    await Promise.all([lookup, detailWait]);
    marks.memory = elapsed();

    const seen = detailNow();
    const detailSeen = seen && seen.ok ? seen.value : null;
    const sel = selectStored(rows, detailSeen?.condition.grade ?? null, cfg, deps.now(), fp.country, ident.category);
    const gate =
      sel.stored === null
        ? ({ outcome: "miss", reason: sel.reason } as const)
        : memoryGate(sel.stored, fp, detailSeen, cfg);
    const round1 = (n: number) => Math.round(n * 10) / 10;
    steps.memory = {
      key,
      hit: gate.outcome === "hit",
      outcome: gate.outcome,
      reason: gate.reason,
      candidates: sel.candidates,
      ...(sel.check && sel.check.ok ? { ageDays: round1(sel.check.ageDays), maxAgeDays: sel.check.maxAgeDays } : {}),
    };

    if (gate.outcome !== "miss" && sel.stored && sel.check && sel.check.ok && detailSeen) {
      const stored = sel.stored;
      const age = sel.check;
      const memoryLabels = labelsOf("memory");
      const rebuilt = stored.result.factors.filter(
        (f) => !memoryLabels.includes(f.label) && !labelsOf("condition").includes(f.label) && !labelsOf("details").includes(f.label),
      );

      if (gate.outcome === "hit") {
        // HIT: straight to the Judge (diagram). The Detail eye's fresh lines replace the stored condition lines. If the Judge
        // cannot answer in time, the stored answer is used as before (a little less sure, as it ages).
        steps.details = detailSeen;
        const fresh = freshDetailFactors(detailSeen, input.lang);
        const hitFallback = (): BrainRun => {
          const fromStore: BrainResult = {
            ...stored.result,
            fromMemory: true,
            degraded: [...degraded],
            confidenceScore: Math.max(5, stored.result.confidenceScore - ageDecay(age.ageDays, age.maxAgeDays)),
            factors: [...rebuilt.slice(0, 1), ...fresh, ...rebuilt.slice(1), { label: T(input.lang).labels.memory, detail: T(input.lang).memoryHit }],
          };
          const checked = checkResult(fromStore, { ...EMPTY_EVIDENCE, fromMemory: true, judgeRan: false }, riskFromFlag(stored.result.authenticityFlag), false, input.lang);
          steps.timing = { ...marks, end: elapsed() };
          return { result: checked, memoryHit: true, fingerprint: fp, saveable: false, memoryEligible: false, memoryRunId: stored.runId, steps, searchLog: [] };
        };
        rs.softStored = { stored, ageDays: age.ageDays, maxAgeDays: age.maxAgeDays, hit: true, hitFallback };
        degraded.push("memory_hit_judged");
      } else {
        // JUDGE: same item, but its condition is one grade away from what was stored. The saved listings go to the
        // Judge together with the Detail eye's report and the photo. No new search, so this is quick.
        rs.softStored = { stored, ageDays: age.ageDays, maxAgeDays: age.maxAgeDays, hit: false, hitFallback: null };

        degraded.push("memory_condition_differs", "memory_judged");
      }
    }
  } else {
    steps.memory = { key, skipped: true };
  }
  return null;
}
