// Plan limits, pure logic (no I/O) so it is testable.
// Keep in sync with src/lib/plans.ts (the UI copy). Hard limits: a blocked request must run NO pipeline stage.
// Free is a one-time allowance of 20 scans in total (never renews). Pro and Premium renew monthly, with no daily cap.

export type PlanId = "free" | "pro" | "premium" | "business";

export const PLAN_LIMITS: Record<PlanId, { perMonth: number; perDay: number | null }> = {
  free: { perMonth: 20, perDay: null }, // perMonth here is the TOTAL for Free
  pro: { perMonth: 300, perDay: null },
  premium: { perMonth: 1000, perDay: null },
  business: { perMonth: 5000, perDay: null },
};

export type LimitCheck = { ok: true } | { ok: false; code: "limit_total" | "limit_month" | "limit_day"; plan: PlanId };

/** Unknown plan or a canceled/past-due subscription counts as free. Repeats (free) must be excluded from the counts by the caller. */
export function normalizePlan(plan: unknown, status: unknown = "active"): PlanId {
  if (status === "canceled") return "free";
  return plan === "pro" || plan === "premium" || plan === "business" ? plan : "free";
}

/** usedTotal = every counted scan ever (used for Free only). */
export function checkLimits(plan: PlanId, usedThisMonth: number, usedToday: number, usedTotal: number = usedThisMonth): LimitCheck {
  const lim = PLAN_LIMITS[plan];
  if (plan === "free") return usedTotal >= lim.perMonth ? { ok: false, code: "limit_total", plan } : { ok: true };
  if (usedThisMonth >= lim.perMonth) return { ok: false, code: "limit_month", plan };
  if (lim.perDay !== null && usedToday >= lim.perDay) return { ok: false, code: "limit_day", plan };
  return { ok: true };
}
