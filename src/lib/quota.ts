// Daily valuation limit. Pure logic, no React, safe to import in Node (tests).
//
// The app has no accounts, so the count lives on the device (localStorage), keyed by the user's LOCAL calendar day.
// It renews at local midnight. If storage is blocked (private mode), it falls back to memory for the session.
//
// What the user sees (see texts.ts -> quota):
//   - Before the second valuation result: nothing. The limit is never mentioned up front.
//   - From the second result on: a quiet "13 of 15 valuations left today".
//   - At 0 left: an encouraging note, and the camera is replaced by a calm "back tomorrow" screen.

import { PLANS, type PlanId } from "./plans.ts";

export const DAILY_LIMIT = 15;

/** The counter first appears on the result of this valuation (2 = the second one of the day). */
export const REVEAL_FROM_SCAN = 2;

const KEY = "valy.daily.v1";
const MONTH_KEY = "valy.monthly.v1";
const TOTAL_KEY = "valy.total.v1";

/** Limits for a plan. No plan given = the old device rule (15 a day, no month cap). Free = month only. */
export function limitsFor(plan?: PlanId): { perDay: number | null; perMonth: number | null; lifetime: boolean } {
  if (!plan) return { perDay: DAILY_LIMIT, perMonth: null, lifetime: false };
  const p = PLANS.find((x) => x.id === plan) ?? PLANS[0];
  return { perDay: p.scansPerDay, perMonth: p.scansPerMonth, lifetime: p.lifetime === true };
}

/** Local calendar month, "2026-11". */
export function monthKey(d: Date): string {
  return dayKey(d).slice(0, 7);
}

/** First moment of next local month. */
export function nextMonthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface QuotaState {
  used: number;
  left: number;
  max: number;
  /** No valuations left today. */
  limitReached: boolean;
  /** Whether a result screen should show the counter yet. */
  showCounter: boolean;
  /** Epoch ms when the limit renews: next local midnight, or the 1st of next month for a plan with no daily cap (Free). */
  resetsAt: number;
  /** Plan-driven only. Valuations used / allowed this calendar month. */
  monthUsed: number;
  monthMax: number;
  monthLeft: number;
  /** Free: the allowance is a one-time total that never renews. */
  lifetime: boolean;
}

/** Local calendar day, "2026-10-31". Local on purpose: "tomorrow" means the user's tomorrow. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The next local midnight after `d`. Built from calendar parts so daylight-saving days stay correct. */
export function nextMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
}

/** Whole hours and minutes until `resetsAt`, rounded up to the minute so it never says "0h 0m" while still locked. */
export function timeUntil(resetsAt: number, now: number): { hours: number; minutes: number } {
  const mins = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  return { hours: Math.floor(mins / 60), minutes: mins % 60 };
}

/** An in-memory store, used when localStorage is missing or blocked. */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

let fallback: KeyValueStore | null = null;

/** The device's localStorage when usable, otherwise a memory store that lasts for the session. */
export function defaultStore(): KeyValueStore {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "valy.probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    // blocked: fall through to memory
  }
  return (fallback ??= memoryStore());
}

function readCount(store: KeyValueStore, key: string, field: "day" | "month", current: string, cap: number): number {
  try {
    const raw = store.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed[field] !== current) return 0; // a new day or month: the counter starts over
    const used = Number(parsed.used);
    return Number.isInteger(used) ? Math.min(Math.max(used, 0), cap) : 0;
  } catch {
    return 0; // broken value: never lock a user out because of it
  }
}

const BIG = 1_000_000;

/** All scans ever made on this device (Free is a one-time allowance). */
function readTotal(store: KeyValueStore): number {
  try {
    const raw = store.getItem(TOTAL_KEY);
    if (!raw) return 0;
    const used = Number((JSON.parse(raw) as { used?: unknown }).used);
    return Number.isInteger(used) ? Math.min(Math.max(used, 0), BIG) : 0;
  } catch {
    return 0;
  }
}

function stateOf(day: number, month: number, now: Date, plan?: PlanId): QuotaState {
  const { perDay, perMonth, lifetime } = limitsFor(plan);
  const dayLeft = perDay === null ? Infinity : perDay - day;
  const monthLeft = perMonth === null ? Infinity : perMonth - month;
  const left = Math.min(dayLeft, monthLeft);
  // The number the counter is measured against: the tighter of the two limits that apply.
  const max = dayLeft <= monthLeft && perDay !== null ? perDay : (perMonth ?? DAILY_LIMIT);
  return {
    used: max - left,
    left,
    max,
    limitReached: left <= 0,
    showCounter: perDay === null ? true : day >= REVEAL_FROM_SCAN,
    resetsAt: (perDay === null || monthLeft <= 0 ? nextMonthStart(now) : nextMidnight(now)).getTime(),
    monthUsed: month,
    monthMax: perMonth ?? 0,
    monthLeft: perMonth === null ? 0 : monthLeft,
    lifetime,
  };
}

function counts(store: KeyValueStore, now: Date, plan?: PlanId): [number, number] {
  const { perDay, lifetime } = limitsFor(plan);
  return [
    readCount(store, KEY, "day", dayKey(now), perDay ?? BIG),
    lifetime ? readTotal(store) : readCount(store, MONTH_KEY, "month", monthKey(now), BIG),
  ];
}

export function readQuota(store: KeyValueStore = defaultStore(), now: Date = new Date(), plan?: PlanId): QuotaState {
  const [d, m] = counts(store, now, plan);
  return stateOf(d, m, now, plan);
}

/** Counts one finished valuation. Call it when a valuation succeeded, so a failed scan never costs the user one. */
export function recordScan(store: KeyValueStore = defaultStore(), now: Date = new Date(), plan?: PlanId): QuotaState {
  const [d0, m0] = counts(store, now, plan);
  const { perDay, lifetime } = limitsFor(plan);
  const d = Math.min(d0 + 1, perDay ?? BIG);
  const m = m0 + 1;
  try {
    store.setItem(KEY, JSON.stringify({ day: dayKey(now), used: d }));
    if (lifetime) store.setItem(TOTAL_KEY, JSON.stringify({ used: m }));
    else store.setItem(MONTH_KEY, JSON.stringify({ month: monthKey(now), used: m }));
  } catch {
    // storage full or blocked: the count still holds for this render, it just will not survive a reload
  }
  return stateOf(d, m, now, plan);
}

/**
 * Counts a finished valuation unless the server said it was a repeat (the same device scanning the same item again within
 * its rolling 24 hours). The server decides, so the app never charges a repeat the server calls free.
 */
export function recordUnlessRepeat(repeat: boolean, store: KeyValueStore = defaultStore(), now: Date = new Date(), plan?: PlanId): QuotaState {
  return repeat ? readQuota(store, now, plan) : recordScan(store, now, plan);
}
