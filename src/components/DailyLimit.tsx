import { Sunrise } from "lucide-react";
import { DAILY_LIMIT, timeUntil } from "@/lib/quota";
import { TEXTS } from "@/lib/texts";

interface Props {
  /** Epoch ms when the limit renews (next local midnight). */
  resetsAt: number;
  onViewHistory: () => void;
  onViewPlans?: () => void;
  /** Set when the SERVER refused (plan limit). Without it the old device counter's wording is used. */
  planLimit?: "limit_total" | "limit_month" | "limit_day" | null;
}

/** Takes the camera's place once today's valuations are used. Calm and positive: the day was a good one, tomorrow is open. */
export function DailyLimit({ resetsAt, onViewHistory, onViewPlans, planLimit }: Props) {
  const { hours, minutes } = timeUntil(resetsAt, Date.now());
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center font-display">
      <div className="mb-6 grid h-16 w-16 place-items-center rounded-full border border-[var(--rule)] bg-plate text-cream">
        <Sunrise size={26} strokeWidth={1.5} />
      </div>
      <h2 className="text-[1.7rem] font-medium leading-tight tracking-[-0.03em] text-cream">
        {planLimit === "limit_total" ? TEXTS.quota.totalTitle : planLimit === "limit_month" ? TEXTS.quota.monthTitle : planLimit === "limit_day" ? TEXTS.quota.dayTitle : TEXTS.quota.reachedTitle(DAILY_LIMIT)}
      </h2>
      <p className="mt-3 max-w-xs text-[0.95rem] leading-relaxed text-mist">{planLimit === "limit_total" ? TEXTS.quota.totalBody : planLimit === "limit_month" ? TEXTS.quota.monthBody : planLimit === "limit_day" ? TEXTS.quota.dayBody : TEXTS.quota.reachedBody}</p>
      {planLimit !== "limit_month" && planLimit !== "limit_total" && <p className="mt-5 text-xs tabular-nums text-dusk">{TEXTS.quota.renewsIn(hours, minutes)}</p>}
      <button type="button" onClick={onViewHistory} className="btn-cream mt-8 max-w-xs font-display">
        {TEXTS.quota.viewHistory}
      </button>
      {onViewPlans && (
        <button type="button" onClick={onViewPlans} className="mt-5 text-[0.875rem] font-medium text-mist transition hover:text-cream">
          {TEXTS.plans.openPlans}
        </button>
      )}
    </div>
  );
}
