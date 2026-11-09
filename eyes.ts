import { type BrainRun, type Fingerprint, type Identification } from "../../types.ts";
import { NEIGHBOUR_MAX_AGE_MS, NEIGHBOUR_WAIT_MS, SEARCH_MIN_MS } from "../timing.ts";
import { judgeA, type JudgeAReport } from "../../judge-a.ts";
import { type NeighbourRow } from "../../neighbour-prior.ts";
import { errText, settle } from "../async.ts";
import { buildFingerprint, memoryKey } from "../../memory.ts";
import { needsPhotoResult } from "../assemble.ts";
import { valuationModeOf } from "../../anchor.ts";
import { authenticityEye, detailEye, identify } from "../../eyes.ts";
import type { RunState } from "../state.ts";

/** Eyes: Detail eye + Authenticity eye + Identification start together; Judge-A and the neighbour prior start right after Identification. Returns a BrainRun only when there is nothing to value. */
export async function eyesStage(rs: RunState): Promise<BrainRun | null> {
  const { input, cfg, deps, opts, degraded, steps, marks, elapsed, judgeEnd } = rs;

  const { identAbort, detailAbort, authAbort } = rs;
  const identHardMs = Math.max(800, Math.min(cfg.eyesMs + 1200, judgeEnd - cfg.judgeTargetMs - SEARCH_MIN_MS));

  const detailP = settle(
    detailEye(deps, cfg, input, Math.max(1500, judgeEnd - 1200), detailAbort.signal),
    (s) => {
      rs.detailState = s;
      marks.detail_eye = elapsed();
    },
  );
  const identP = settle(identify(deps, cfg, input, identHardMs, identAbort.signal), () => {
    marks.identification = elapsed();
  });

  // The Authenticity eye (the unique eye: fake signs, era from construction, repairs, rarity, originality, material cues; no text, no name). Same moment as the other two eyes. Goes to the Judge and to Market Live.
  const authP = settle(authenticityEye(deps, cfg, input, Math.max(1500, judgeEnd - 1200), authAbort.signal), (s) => {
    rs.authState = s;
    marks.authenticity_eye = elapsed();
  });

  const identSettled = await identP;
  let ident: Identification | null = null;
  if (identSettled.ok) ident = identSettled.value;
  else {
    degraded.push("identification_failed");
    deps.log("identification failed", errText(identSettled.error));
  }
  steps.identification = ident ?? { failed: true };

  // Identification says there is nothing to value: no need to spend more.
  if (ident && !ident.identifiable) {
    detailAbort.abort();
    authAbort.abort();
    steps.timing = { ...marks, end: elapsed() };
    return {
      result: needsPhotoResult(ident, degraded, input.lang),
      memoryHit: false,
      fingerprint: null,
      saveable: false,
      memoryEligible: false,
      memoryRunId: null,
      steps,
      searchLog: [],
    };
  }

  const fp: Fingerprint | null = ident ? buildFingerprint(ident, input.country, valuationModeOf(ident)) : null;
  const key = fp ? memoryKey(fp, input.lang) : null;
  steps.fingerprint = fp;

  // Judge-A: the independent price anchor. Photo only, never sees ads. Starts now and runs beside Market Live.
  // The Judge waits up to JUDGE_A_GRACE_MS for Judge-A before its own time is calculated, and that wait is taken out of the Judge's time
  // (the 7 s limit does not move, the Judge gets less time). A failed call is simply a missing source.
  // judgeASeen: what Judge-A had answered when the Judge call starts (pickEffort peeks, it never waits for Judge-A).
  const judgeAP: Promise<JudgeAReport | null> = ident
    ? judgeA(deps, cfg, input, ident, Math.max(600, Math.min(2500, judgeEnd - cfg.judgeTargetMs - elapsed() - 300))).then((r) => { marks.judge_a = elapsed(); rs.judgeASeen = r; return r; })
    : Promise.resolve(null);

  // Neighbour prior: saved results of similar items (same category + brand) as one weak, wide source. Beside everything else, 600 ms
  // give-up, never delays the Judge; any failure = no source.
  const neighboursP: Promise<NeighbourRow[] | null> = fp && opts.memory?.findNeighbours
    ? Promise.race([opts.memory.findNeighbours(fp, NEIGHBOUR_MAX_AGE_MS).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), NEIGHBOUR_WAIT_MS))])
    : Promise.resolve(null);
  rs.detailP = detailP;
  rs.authP = authP;
  rs.ident = ident;
  rs.fp = fp;
  rs.key = key;
  rs.judgeAP = judgeAP;
  rs.neighboursP = neighboursP;
  return null;
}
