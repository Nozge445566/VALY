// Thompson sampling.
// rng is ALWAYS injected: () => number in [0, 1). Math.random is never called here.

import type { Policy } from "./policy.ts";

export type Rng = () => number;
export type Posterior = { alpha: number; beta: number; nGlobal: number; nSpecific: number };

export const posteriorMean = (p: Posterior): number => p.alpha / p.beta;

function normal(rng: Rng): number {
  let u = rng();
  while (u <= 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape alpha, scale 1). Marsaglia-Tsang for alpha >= 1, boost for alpha < 1. */
export function gammaSample(alpha: number, rng: Rng): number {
  if (alpha < 1) {
    let u = rng();
    while (u <= 0) u = rng();
    return gammaSample(alpha + 1, rng) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    let u = rng();
    while (u <= 0) u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Posterior.sample: gammavariate(alpha, 1/beta) */
export function sample(p: Posterior, rng: Rng): number {
  return gammaSample(p.alpha, rng) / p.beta;
}

/** `contexts` run from the most general to the most specific. */
export function posterior(policy: Policy, contexts: string[], templateId: string): Posterior {
  let mu = policy.priorRate;
  const strength = policy.priorStrength;
  let alpha = mu * strength;
  let beta = strength;
  let nGlobal = 0;
  let nSpecific = 0;
  contexts.forEach((ctx, i) => {
    const [k, t, n] = policy.arms.get(ctx)?.get(templateId) ?? [0, 0, 0];
    alpha = mu * strength + k;
    beta = strength + t;
    mu = alpha / beta;
    if (i === 0) nGlobal = Math.trunc(n);
    nSpecific = Math.trunc(n);
  });
  return { alpha: Math.max(alpha, 1e-6), beta: Math.max(beta, 1e-6), nGlobal, nSpecific };
}
