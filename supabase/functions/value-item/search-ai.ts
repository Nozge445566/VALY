// The link to the Search AI, which runs inside this Edge Function (see _shared/search-ai).
//
// The Search AI only chooses WHICH searches to run. It never outputs prices. Its answer is
// strict JSON and is validated by code. If it errors, is slow, has no data, or its answer
// is invalid, the fixed templates take over (diagram: "Fallback and safety").

import { localPlan } from "../_shared/search-ai/local-engine.ts";
import type { BrainConfig, Deps } from "./config.ts";
import { fixedPlan } from "./fixed-templates.ts";
import type { Fingerprint, SearchPlan } from "./types.ts";
import { validateSearchPlan } from "./validate.ts";

export interface PlanResult {
  plan: SearchPlan;
  /** Why the fixed templates were used, or null when the Search AI planned the searches. */
  fallbackReason: string | null;
  ms: number;
}

/** The engine call: (fingerprint, Identification's queries) -> the plan JSON, or `{ ok: false, reason }`. Never prices. */
export type LocalPlanFn = (fingerprint: unknown, queries: unknown) => Promise<Record<string, unknown>>;

/**
 * How long the engine may take before the fixed templates are used instead. The engine runs in this process, but the
 * first call after a cold start (or when the learned strategy is stale) reads it from the database, and that read must
 * never eat the Judge's time. The read carries on in the background, so the next answer has the strategy.
 */
export const PLAN_BUDGET_MS = 400;

/** Waits for `work`, but rejects with "timed out" (read as `search_ai_slow`) after `ms`. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`search ai timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function planSearches(
  deps: Deps,
  cfg: BrainConfig,
  fp: Fingerprint,
  identQueries: string[],
  localFn: LocalPlanFn = localPlan,
  budgetMs: number = PLAN_BUDGET_MS,
): Promise<PlanResult> {
  const started = deps.now();
  const fixed = (reason: string): PlanResult => ({
    plan: fixedPlan(fp, identQueries),
    fallbackReason: reason,
    ms: deps.now() - started,
  });

  try {
    const raw = await withinBudget(localFn(fp, identQueries), budgetMs);
    // The Search AI may say honestly that it has nothing to offer for this item yet.
    if (typeof raw === "object" && raw !== null && (raw as { ok?: unknown }).ok === false) {
      const why = String((raw as { reason?: unknown }).reason ?? "declined").replace(/[^a-z_]/gi, "").slice(0, 30) || "declined";
      return fixed(`search_ai_${why.toLowerCase()}`);
    }
    const checked = validateSearchPlan(raw);
    if (!checked.ok) {
      deps.log("search ai plan rejected", checked.errors);
      return fixed("search_ai_invalid");
    }
    return { plan: checked.value, fallbackReason: null, ms: deps.now() - started };
  } catch (e) {
    const timedOut = e instanceof Error && /timed out/i.test(e.message);
    if (timedOut) deps.log(`[Brain] search ai skipped (budget ${PLAN_BUDGET_MS} ms), using fixed templates`);
    else deps.log("search ai failed", e instanceof Error ? e.message : String(e));
    return fixed(timedOut ? "search_ai_slow" : "search_ai_error");
  }
}
