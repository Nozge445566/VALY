// Backtest + simulation harness. Pure: replays STORED recipes (l_runs.steps.interval) through the
// fused engine and scores them against the real sold price (l_feedback). No network, no model. Targets (spec): coverage of the
// 80 percent interval between 78 and 84 percent, and a median abs ln error / pinball loss no worse than the previous version.
import { buildFusedInterval } from "./fused-interval.ts";
import type { IntervalInput } from "./interval.ts";
import { quantile } from "./stats.ts";

/** What steps.interval holds (see pipeline.ts onInterval). Everything optional except what replay needs. */
export interface StoredInterval {
  v?: number;
  input: Record<string, unknown> & { model: { low: number; mid: number; high: number }; category: string; condition: string; sources?: { name: string; mu: number; sd: number }[] };
  comps: IntervalInput["comps"];
}
export interface BacktestRecord { stored: StoredInterval; truthUsd: number; kOf?: IntervalInput["kOf"]; k?: number }

export interface BacktestScore {
  n: number;
  coverage: number;
  /** Fraction of truths below low, above high. A healthy interval misses on both sides, about equally. */
  below: number;
  above: number;
  medianAbsLnError: number;
  pinball: number;
  medianLnWidth: number;
  /** Median of |ln(truth/mid)| over half the interval's own sd: a score of ~1 means the interval is honest. */
  skipped: number;
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function replayStored(stored: StoredInterval, extra: Partial<IntervalInput> = {}) {
  const i = stored.input as never as Record<string, unknown>;
  return buildFusedInterval({
    category: stored.input.category, condition: stored.input.condition, model: stored.input.model,
    modelConfidence: (i.modelConfidence as number) ?? 50, authenticityRisk: (i.authenticityRisk as string) ?? "low",
    unknownsCount: (i.unknownsCount as number) ?? 0, identitySimilar: !!i.identitySimilar,
    ...(fin(i.askingToSold) ? { askingToSold: i.askingToSold } : {}),
    ...(i.mode === "retail" || i.mode === "auction" ? { mode: i.mode } : {}),
    ...(fin(i.variantAmbiguity) ? { variantAmbiguity: i.variantAmbiguity } : {}),
    ...(typeof i.rarity === "string" ? { rarity: i.rarity } : {}), ...(fin(i.judgeDisagreements) ? { judgeDisagreements: i.judgeDisagreements } : {}),
    fallbackLevel: "local", comps: stored.comps, sources: stored.input.sources ?? [], ...extra,
  } as never);
}

/** Pinball loss of the three quantiles (0.1, 0.5, 0.9) in ln space, averaged. */
export function pinball(low: number, mid: number, high: number, truth: number): number {
  const L = (q: number, p: number) => { const d = Math.log(truth) - Math.log(p); return d >= 0 ? q * d : (q - 1) * d; };
  return (L(0.1, low) + L(0.5, mid) + L(0.9, high)) / 3;
}

export function score(records: BacktestRecord[], extra: (r: BacktestRecord) => Partial<IntervalInput> = () => ({})): BacktestScore {
  const err: number[] = [], pin: number[] = [], wid: number[] = [];
  let inside = 0, below = 0, above = 0, skipped = 0;
  for (const r of records) {
    if (!(fin(r.truthUsd) && r.truthUsd > 0)) { skipped++; continue; }
    let o;
    try { o = replayStored(r.stored, { ...(r.kOf ? { kOf: r.kOf } : {}), ...(r.k !== undefined ? { k: r.k } : {}), ...extra(r) }); } catch { skipped++; continue; }
    if (!(fin(o.low) && fin(o.mid) && fin(o.high))) { skipped++; continue; }
    if (r.truthUsd < o.low) below++; else if (r.truthUsd > o.high) above++; else inside++;
    err.push(Math.abs(Math.log(r.truthUsd / o.mid))); pin.push(pinball(o.low, o.mid, o.high, r.truthUsd)); wid.push(Math.log(o.high / o.low));
  }
  const n = err.length;
  const med = (a: number[]) => (a.length ? quantile([...a].sort((x, y) => x - y), 0.5) : 0);
  return { n, coverage: n ? inside / n : 0, below: n ? below / n : 0, above: n ? above / n : 0, medianAbsLnError: med(err), pinball: n ? pin.reduce((a, b) => a + b, 0) / n : 0, medianLnWidth: med(wid), skipped };
}

/**
 * Split-conformal scale (k) for the interval: the smallest multiplier on the current half-width such that `target` of the
 * calibration truths fall inside. Returns a k to hand to the engine through `k` / `kOf`, clamped by the engine's own K_MIN/K_MAX.
 * Needs at least `minN` records, otherwise null (keep the default: a few points must not move the calibration).
 */
export function conformalK(records: BacktestRecord[], target = 0.8, minN = 30): number | null {
  const ratios: number[] = [];
  for (const r of records) {
    if (!(fin(r.truthUsd) && r.truthUsd > 0)) continue;
    let o; try { o = replayStored(r.stored, { k: 1 }); } catch { continue; }
    const half = r.truthUsd >= o.mid ? Math.log(o.high / o.mid) : Math.log(o.mid / o.low);
    if (!(half > 0)) continue;
    ratios.push(Math.abs(Math.log(r.truthUsd / o.mid)) / half);
  }
  if (ratios.length < minN) return null;
  ratios.sort((a, b) => a - b);
  // finite-sample conformal quantile: ceil((n+1) * target) / n
  const idx = Math.min(ratios.length - 1, Math.ceil((ratios.length + 1) * target) - 1);
  return ratios[idx];
}

// ---------------------------------------------------------------- simulation

/** Small deterministic PRNG so a simulation is reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
  return { u, normal };
}

/**
 * Synthetic world: a true price, n ads whose ln price is truth + item noise (+ a shared variant bias, + occasional outlier),
 * judged with the model's own noise assumptions. Used to check coverage of the engine in a world where the answer is known.
 * It proves the engine is self-consistent; it does NOT prove anything about real scans.
 */
export function simulate(opts: { runs: number; seed?: number; nAds?: number; adSd?: number; sharedBiasSd?: number; outlierRate?: number; category?: string }): BacktestRecord[] {
  const r = rng(opts.seed ?? 1);
  const out: BacktestRecord[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const truth = Math.exp(Math.log(20) + r.u() * Math.log(500 / 20));
    const bias = r.normal() * (opts.sharedBiasSd ?? 0.08);
    const n = opts.nAds ?? 3 + Math.floor(r.u() * 10);
    const comps = [];
    for (let j = 0; j < n; j++) {
      let y = Math.log(truth) + bias + r.normal() * (opts.adSd ?? 0.15);
      if (r.u() < (opts.outlierRate ?? 0.05)) y += (r.u() < 0.5 ? -1 : 1) * (0.7 + r.u());
      const sold = r.u() < 0.6;
      comps.push({ priceUsd: Math.exp(y) / (sold ? 1 : 0.9), kind: sold ? "sold" : "asking", match: "same", tier: "local" });
    }
    out.push({ truthUsd: truth, stored: { input: { model: { low: truth * 0.6, mid: truth * 1.1, high: truth * 1.8 }, category: opts.category ?? "electronics", condition: "good", sources: [] }, comps: comps as never } });
  }
  return out;
}
