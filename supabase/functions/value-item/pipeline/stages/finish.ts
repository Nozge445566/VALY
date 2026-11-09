import { ASKING_TO_SOLD, CONDITION_FACTOR, INTERVAL_COMPS_STORED } from "../../interval.config.ts";
import { type BrainResult, type BrainRun, type JudgeVerdict } from "../../types.ts";
import { HARD_CAPS } from "../../config.ts";
import { FINISH_RESERVE_MS } from "../timing.ts";
import { freshDetailFactors } from "../../present.ts";
import { neighbourSource } from "../../neighbour-prior.ts";
import { type RecipeSource } from "../../fused-interval.ts";
import { applySecondLook, SECOND_LOOK_MS, secondLook, softContested } from "../../second-look.ts";
import { errText } from "../async.ts";
import { ageDecay, storableReason } from "../../memory.ts";
import { labelsOf, T } from "../../lang.ts";
import { adFactor, adNoise, variantAmbiguityOf } from "../../ad-calibration.ts";
import { adjudicate } from "../../consistency.ts";
import { anchorEstimate, isCollectorLike, mergeEyeFacts } from "../../anchor.ts";
import { type AssembleArgs, assemble, evidenceFrom, isRetailNew, needsPhotoResult } from "../assemble.ts";
import { confidenceLabel } from "../../numbers.ts";
import { fuse } from "../../fusion.ts";
import { priceFromLabels } from "../../math.ts";
import { judgeEvidence, JUDGE_STRENGTH } from "../../../_shared/search-ai/beliefs.ts";
import { productionSourceBeliefs } from "../../../_shared/search-ai/local-engine.ts";
import { estimateLadder, logsFor, type RunState } from "../state.ts";

/** Maths and checks, then check and exchange rates (code only). Returns the final BrainRun. */
export async function finishStage(rs: RunState): Promise<BrainRun> {
  const { input, cfg, deps, opts, degraded, steps, marks, elapsed } = rs;
  const { ident, fp, key, neighboursP } = rs;
  const { findings, details, authenticity, judgeRan, softStored, marketState } = rs;
  let verdict = rs.verdict as JudgeVerdict;
  let estimateMode = rs.estimateMode;

  if (!verdict.identifiable) {
    steps.timing = { ...marks, end: elapsed() };
    return {
      result: needsPhotoResult(ident, degraded, input.lang),
      memoryHit: false,
      fingerprint: fp,
      saveable: false,
      memoryEligible: false,
      memoryRunId: null,
      steps,
      ...logsFor(rs, verdict),
    };
  }

  // ------------------------------------------------ Maths and checks (code): the Judge only labelled, code makes every number
  let priceAdjust: Map<number, number> | undefined;
  let judgeDisagreements = 0;
  let fusionSources: RecipeSource[] = [];
  if (judgeRan && verdict.ads) {
    // Consistency adjudicator (pure): deterministic cross-checks of the Judge against the ads, Identification and the eyes.
    // Rule R3 needs an INDEPENDENT anchor: the bounded facts of Identification (never saw the ads) qualify when the model is known.
    const anchorForR3 = ident && ident.identifiable
      ? anchorEstimate({ new_price_usd: ident.new_price_usd, new_price_basis: ident.new_price_basis, category: ident.category.toLowerCase(), age_class: ident.age_class ?? mergeEyeFacts(ident, authenticity)?.age_class, condition: verdict.condition?.grade ?? null, rarity: ident.rarity ?? mergeEyeFacts(ident, authenticity)?.rarity })
      : null;
    // Collectible, antique or rare items: their real listings may sit far above a depreciated anchor, so R3 must not demote them.
    const anchorUsdR3 = isCollectorLike(mergeEyeFacts(ident, authenticity)) ? null : anchorForR3 && anchorForR3.basis === "known_model" ? anchorForR3.mid : null;
    const adj = adjudicate(verdict, findings, ident, authenticity, anchorUsdR3);
    verdict = { ...verdict, ads: adj.ads, authenticity_risk: adj.risk };
    // Second look (tighten-only, 600 ms, only when time is left): ads demoted by a soft rule are asked once more; "different" demotes, nothing is ever promoted.
    const soft = ident ? softContested(adj.disagreements) : [];
    if (ident && soft.length > 0 && elapsed() + SECOND_LOOK_MS + FINISH_RESERVE_MS < cfg.answerMs) {
      const answers = await secondLook(deps, cfg, ident, findings, soft, SECOND_LOOK_MS);
      const merged = applySecondLook(verdict.ads ?? [], answers);
      steps.secondLook = { asked: soft, answered: answers.size, demoted: merged.changed };
      if (merged.changed.length > 0) {
        verdict = { ...verdict, ads: merged.ads };
        for (const id of merged.changed) adj.disagreements.push({ rule: "second_look_different", adId: id, detail: `second look: ad ${id} is a different item` });
      }
    }
    // Search AI learns from the Judge too (after the checks and the second look, so a demoted ad counts as "different"). Never costs an answer.
    try {
      const ev = judgeEvidence(findings, verdict.ads ?? []);
      if (ev.length > 0) (opts.sourceBeliefs ?? productionSourceBeliefs()).record(ev, JUDGE_STRENGTH);
    } catch (e) {
      deps.log("judge evidence failed", errText(e));
    }
    if (adj.disagreements.length > 0) {
      steps.consistency = adj.disagreements;
      judgeDisagreements = adj.disagreements.length;
      degraded.push("judge_disagreement");
    }
    const retailNew = isRetailNew(mergeEyeFacts(ident, authenticity), verdict.condition.grade);
    const a2s = retailNew ? 1 : ASKING_TO_SOLD;
    steps.modes = { newItem: retailNew, askingToSold: a2s };
    const m = priceFromLabels(verdict, findings, a2s);
    steps.math = m ? m.notes : { noComparableAds: true };
    // Fusion log: the fused result of the Judge-labelled ads and anchors, logged in steps.fusion for the backtest.
    try {
      const lab = new Map((verdict.ads ?? []).map((a) => [a.id, a]));
      const fAds = findings
        .filter((f) => f.priceUsd > 0 && lab.has(f.id) && (lab.get(f.id)!.match === "same" || lab.get(f.id)!.match === "similar"))
        .map((f) => ({ y: Math.log(f.priceUsd * adFactor(lab.get(f.id)!, CONDITION_FACTOR) * (f.kind === "sold" ? 1 : a2s)), se2: adNoise({ match: lab.get(f.id)!.match, pSame: lab.get(f.id)!.p_same, reliability: lab.get(f.id)!.ad_reliability, relative: lab.get(f.id)!.relative_value, asking: f.kind !== "sold" }) ?? 0.12 }));
      const srcs: RecipeSource[] = [];
      if (anchorForR3) srcs.push({ name: "identification", mu: Math.log(anchorForR3.mid), sd: anchorForR3.lnStd });
      const nb = neighbourSource((await neighboursP) ?? [], deps.now());
      steps.neighbours = nb ? { n: nb.n, mid: Math.round(Math.exp(nb.mu)), sd: Math.round(nb.sd * 1000) / 1000 } : { none: true };
      if (nb) srcs.push({ name: "neighbours", mu: nb.mu, sd: nb.sd });
      fusionSources = srcs;
      const fz = fuse({ ads: fAds, sources: srcs, variantAmbiguity: variantAmbiguityOf({ identConfidence: ident?.confidence ?? null, similarShare: fAds.length ? findings.filter((f) => lab.get(f.id)?.match === "similar").length / fAds.length : null }) });
      steps.fusion = fz ? { low: Math.round(fz.low), mid: Math.round(fz.mid), high: Math.round(fz.high), df: fz.df, tau2: fz.tau2, nEff: fz.nEff, influence: fz.influence, sourceWeights: fz.sourceWeights, tempered: fz.tempered, shadow: false } : { none: true };
    } catch (e) {
      steps.fusion = { error: errText(e) };
    }
    if (!m) {
      // No ad that is the same or similar: a price would have to be guessed by a model, which is not allowed. Ask for a better photo.
      degraded.push("no_comparable_ads");
      const est = await estimateLadder(rs);
      if (est) {
        degraded.push("no_market_estimate");
        verdict = est.verdict;
        estimateMode = true;
      }
    }
    if (!m && !estimateMode) {
      steps.timing = { ...marks, end: elapsed() };
      return { result: needsPhotoResult(ident, degraded, input.lang, T(input.lang).estimate.noAnchor), memoryHit: false, fingerprint: fp, saveable: false, memoryEligible: false, memoryRunId: null, steps, ...logsFor(rs, verdict) };
    }
    if (m) {
      verdict = m.verdict;
      priceAdjust = m.adjusted;
    }
  }

  // ------------------------------------------------ Check and exchange rates (code)
  const asmArgs: AssembleArgs = {
    verdict,
    ident: mergeEyeFacts(ident, authenticity), // Authenticity eye fills empty rarity/material/age only; the recipe then carries the rarity into the interval
    details,
    findings,
    marketState,
    soldTarget: HARD_CAPS.soldPrices,
    degraded,
    judgeRan,
    judgeDisagreements,
    fusionSources,
    identConfidence: ident?.confidence ?? null,
    country: fp ? fp.country : input.country,
    lang: input.lang,
    memoryAgeDays: softStored?.ageDays,
    authenticity,
    priceAdjust,
    kOf: opts.calibrationK,
    priceOffsets: opts.priceOffsets,
    onInterval: (iv, recipe) => {
      // Calibration (section 6) and the backtest read this: everything needed to replay the
      // interval. It is copied from the recipe the engine used, never rebuilt here.
      // `comps` (at most 15 listings, rounded to cents) lets a backtest replay without the live search.
      steps.interval = {
        ...iv.breakdown,
        marketWeight: iv.marketWeight,
        widthDrivers: iv.widthDrivers,
        v: recipe.v,
        input: {
          model: recipe.model,
          modelConfidence: recipe.modelConfidence,
          category: recipe.category,
          condition: recipe.condition,
          authenticityRisk: recipe.authenticityRisk,
          unknownsCount: recipe.unknownsCount,
          identitySimilar: recipe.identitySimilar,
          ...(recipe.askingToSold !== undefined ? { askingToSold: recipe.askingToSold } : {}),
          ...(recipe.mode ? { mode: recipe.mode } : {}),
          ...(recipe.variantAmbiguity !== undefined ? { variantAmbiguity: recipe.variantAmbiguity } : {}),
          ...(recipe.rarity ? { rarity: recipe.rarity } : {}),
          ...(recipe.judgeDisagreements ? { judgeDisagreements: recipe.judgeDisagreements } : {}),
          // Shape v2 (fused engine): the independent anchors it read, in ln USD, so the backtest replays it exactly.
          sources: recipe.sources,
        },
        comps: recipe.comps
          .slice(0, INTERVAL_COMPS_STORED)
          .map((c) => ({
            priceUsd: Math.round(c.priceUsd * 100) / 100, kind: c.kind, match: c.match, tier: c.tier ?? "local",
            ...(c.pSame ? { pSame: c.pSame } : {}), ...(c.reliability ? { reliability: c.reliability } : {}),
            // Needed to learn a price level per country pair, and to replay the shift that was applied.
            origin: c.origin ?? null, shiftLn: c.shiftLn ?? 0, extraStd: c.extraStd ?? null,
          })),
      };
    },
  };
  const assembled = assemble(asmArgs);
  const hit = softStored !== null && softStored.hit;
  // On a HIT the Detail eye's fresh condition lines replace the stored ones, and the Memory line is added.
  const hitFactors = (fs: BrainResult["factors"]): BrainResult["factors"] => {
    const fresh = details ? freshDetailFactors(details, input.lang) : [];
    const keep = fresh.length > 0 ? fs.filter((f) => !labelsOf("condition").includes(f.label) && !labelsOf("details").includes(f.label)) : fs;
    const base = keep.filter((f) => !labelsOf("memory").includes(f.label));
    return [...base.slice(0, 1), ...fresh, ...base.slice(1), { label: T(input.lang).labels.memory, detail: T(input.lang).memoryHit }];
  };
  // A HIT is judged again on saved ads, so it is a little less sure the older those ads are (same decay as the old stored answer).
  const hitScore = hit && softStored ? Math.max(5, assembled.confidenceScore - ageDecay(softStored.ageDays, softStored.maxAgeDays)) : assembled.confidenceScore;
  const result: BrainResult = hit
    ? { ...assembled, fromMemory: true, confidenceScore: hitScore, confidence: confidenceLabel(hitScore), factors: hitFactors(assembled.factors) }
    : assembled;
  steps.check = { score: result.confidenceScore, authenticity: result.authenticityFlag };
  marks.check = elapsed();
  steps.timing = { ...marks, end: elapsed() };

  const evidence = evidenceFrom(judgeRan ? verdict : null, findings, judgeRan && isRetailNew(mergeEyeFacts(ident, authenticity), verdict.condition.grade));
  // The door into Memory (memory.ts, storableReason): every doubt keeps a valuation out.
  const keptCount = evidence.keptSoldUsd.length + evidence.keptAskingUsd.length;
  const notStored = storableReason({ cfg, key, judgeRan, result, ident, verdict, keptCount, degraded, authenticity });
  const memoryEligible = notStored === null;
  steps.memoryStore = { eligible: memoryEligible, reason: notStored };

  return {
    result,
    memoryHit: hit,
    fingerprint: fp,
    // Only NEW valuations are saved: a Memory HIT judged again is never stored a second time.
    saveable: !hit,
    memoryEligible: hit ? false : memoryEligible,
    memoryRunId: hit && softStored ? softStored.stored.runId : null,
    steps,
    ...logsFor(rs, verdict),
  };
}
