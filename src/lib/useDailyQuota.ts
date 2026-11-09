import { useCallback, useEffect, useRef, useState } from "react";
import { readQuota, recordUnlessRepeat, type QuotaState } from "./quota.ts";
import { fetchPlan, type PlanId } from "./plans.ts";

/**
 * MASTER SWITCH for the daily limit (15 per day).
 *   false = TESTING: nobody is ever blocked and the "x of 15 left" counter is hidden.
 *   true  = LIVE:    the limit works exactly as before.
 * Nothing else was removed. The counting, the "back tomorrow" screen and the texts are all still in place, so turning
 * the limit back on is just changing this one word to `true`.
 */
export const DAILY_LIMIT_ENABLED = false;

/**
 * The daily limit as React state. It re-reads storage when the tab comes back to the foreground, when another tab
 * changes the count, and every 30 s, so a limit that expires at midnight lifts itself without a reload.
 */
export function useDailyQuota(): QuotaState & { record: (repeat?: boolean) => void } {
  // The plan decides the limits (Free 20 in total, Pro 300/month, Premium 1000/month). Unknown plan = the old device rule.
  // Only read while the limit is switched on, so nothing extra happens during testing.
  const [plan, setPlan] = useState<PlanId | undefined>(undefined);
  const planRef = useRef<PlanId | undefined>(undefined);
  planRef.current = plan;
  const [state, setState] = useState<QuotaState>(() => readQuota());

  const refresh = useCallback(() => setState(readQuota(undefined, new Date(), planRef.current)), []);
  const record = useCallback((repeat = false) => setState(recordUnlessRepeat(repeat, undefined, new Date(), planRef.current)), []);

  useEffect(() => {
    if (!DAILY_LIMIT_ENABLED) return;
    let alive = true;
    const load = () =>
      void fetchPlan().then((p) => {
        if (alive) setPlan(p);
      });
    load();
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => refresh(), [plan, refresh]);

  useEffect(() => {
    const tick = setInterval(refresh, 30_000);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", refresh);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", refresh);
    };
  }, [refresh]);

  // While the limit is switched off, hide the "limit reached" and "counter" states. Counting carries on quietly.
  const effective: QuotaState = DAILY_LIMIT_ENABLED ? state : { ...state, limitReached: false, showCounter: false };
  return { ...effective, record };
}
