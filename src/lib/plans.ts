// Pricing plans: the single source of prices and limits for the UI (SEK incl. 25 % VAT).
// Limits are HARD limits enforced server-side (supabase/functions/value-item/plan-limits.ts, keep the two in sync);
// the client only displays them. Subscriptions are created through Stripe Checkout (supabase/functions/create-checkout).

export type PlanId = "free" | "pro" | "premium" | "business";
export type Billing = "monthly" | "yearly";

export interface Plan {
  id: PlanId;
  /** SEK incl. 25 % VAT. */
  priceMonth: number;
  priceYear: number;
  scansPerMonth: number;
  /** null = no daily cap. */
  scansPerDay: number | null;
  /** Free only: scansPerMonth is a one-time total, it never renews. */
  lifetime?: boolean;
}

export const PLANS: readonly Plan[] = [
  { id: "free", priceMonth: 0, priceYear: 0, scansPerMonth: 20, scansPerDay: null, lifetime: true },
  { id: "pro", priceMonth: 99, priceYear: 1188, scansPerMonth: 300, scansPerDay: null },
  { id: "premium", priceMonth: 199, priceYear: 2388, scansPerMonth: 1000, scansPerDay: null },
  { id: "business", priceMonth: 749, priceYear: 8988, scansPerMonth: 5000, scansPerDay: null },
];

/** Yearly saving vs 12 x monthly, in whole percent. */
export function yearlySavingPct(p: Plan): number {
  return p.priceMonth === 0 ? 0 : Math.round((1 - p.priceYear / (p.priceMonth * 12)) * 100);
}

const KEY = "valy.plan.v1";
const PENDING = "valy.pendingPlan";

/** The plan a signed-out person tapped; kept across the OAuth / email-link round trip (localStorage: the email link may open in another tab). */
export function setPendingPlan(plan: Exclude<PlanId, "free">): void {
  try {
    localStorage.setItem(PENDING, plan);
  } catch {
    // blocked storage: the person just taps the plan again after signing in
  }
}
export function peekPendingPlan(): Exclude<PlanId, "free"> | null {
  try {
    const v = localStorage.getItem(PENDING);
    return v === "pro" || v === "premium" || v === "business" ? v : null;
  } catch {
    return null;
  }
}
export function clearPendingPlan(): void {
  try {
    localStorage.removeItem(PENDING);
  } catch {
    // ignore
  }
}

/** The plan this device is on. Stub: always "free" until billing is connected. */
export function readPlan(): PlanId {
  try {
    const v = localStorage.getItem(KEY);
    return v === "pro" || v === "premium" || v === "business" ? v : "free";
  } catch {
    return "free";
  }
}

/**
 * The signed-in user's plan from `subscriptions` (RLS: own row only). Falls back to the device stub, then "free",
 * so the app works before the table or Stripe exist.
 */
export async function fetchPlan(): Promise<PlanId> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    const uid = await ensureSession();
    const { data, error } = await supabase.from("subscriptions").select("plan,status").eq("user_id", uid).maybeSingle();
    if (error || !data || data.status === "canceled") return readPlan();
    return data.plan === "pro" || data.plan === "premium" || data.plan === "business" ? data.plan : "free";
  } catch {
    return readPlan();
  }
}

/** Starts Stripe Checkout through the `create-checkout` edge function. Returns the URL, or null when billing is not live yet. */
export async function startCheckout(plan: Exclude<PlanId, "free">, billing: Billing): Promise<string | null> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const { data, error } = await supabase.functions.invoke("create-checkout", { body: { plan, billing } });
    return !error && data?.url ? String(data.url) : null;
  } catch {
    return null;
  }
}

/** Opens the Stripe customer portal (manage / cancel). Returns the URL, or null when unavailable. */
export async function openPortal(): Promise<string | null> {
  try {
    const { supabase, ensureSession } = await import("./supabase.ts");
    await ensureSession();
    const { data, error } = await supabase.functions.invoke("customer-portal");
    return !error && data?.url ? String(data.url) : null;
  } catch {
    return null;
  }
}
