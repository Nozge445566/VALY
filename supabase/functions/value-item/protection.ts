// Protection: 20 counted valuations and 60 attempts per device per hour, 500 per network address per hour, 1,500 per day.
// The rate limit is checked BEFORE any paid call. Over the limit:
// reject, no AI cost. Protection has no outgoing arrow: it only decides yes or no.
//
// "Proposed: per user." The app has no login, so a user is an anonymous device id that the app
// creates once and sends with every photo. Because a device id is easy to fake, a looser limit
// per network address and a daily cap for the whole service sit behind it, so no trick can
// empty the AI budget.

import { T } from "./lang.ts";
import type { Lang } from "./lang.ts";
export type UsageVerdict = "ok" | "user_limit" | "attempt_limit" | "ip_limit" | "day_limit";

/**
 * Two kinds of count, told apart by one flag on each l_usage row:
 *   - an ATTEMPT is written for every request that passes the check, before any paid work (the 60);
 *   - a COUNTED valuation is an attempt that later finished successfully and was not a repeat (the 20, 500, 1,500).
 * A failed scan is an attempt only. A repeat (same device, same item, within 24 hours of that item's first valuation) is an
 * attempt only.
 */
export interface Limits {
  /** Counted valuations per device per hour. */
  perUserHour: number;
  /** All attempts per device per hour, failed scans and repeats included. */
  attemptsPerUserHour: number;
  /** Counted valuations per network address per hour. Looser, because many people can share one address. */
  perIpHour: number;
  /** Counted valuations in total over a rolling 24 hours. Protects the keys. */
  perDay: number;
}

export const DEFAULT_LIMITS: Limits = { perUserHour: 20, attemptsPerUserHour: 60, perIpHour: 500, perDay: 1500 };

/** How long a device's first valuation of an item makes scanning that item again free. Rolling, never restarted by a repeat. */
export const REPEAT_WINDOW_MS = 24 * 3600 * 1000;

/** What the database reports before a request is allowed to spend money. */
export interface UsageCounts {
  /** Counted valuations of this device in the last hour. */
  userCounted: number;
  /** All attempts of this device in the last hour. */
  userAttempts: number;
  /** Counted valuations of this network address in the last hour. */
  ipCounted: number;
  /** Counted valuations of the whole service in the last 24 hours. */
  dayCounted: number;
}

/** The checks, in order. The first one that is full decides. Pure, so the rules are tested without a database. */
export function decideVerdict(c: UsageCounts, limits: Limits): UsageVerdict {
  if (c.userCounted >= limits.perUserHour) return "user_limit";
  if (c.userAttempts >= limits.attemptsPerUserHour) return "attempt_limit";
  if (c.ipCounted >= limits.perIpHour) return "ip_limit";
  if (c.dayCounted >= limits.perDay) return "day_limit";
  return "ok";
}

export interface AttemptCheck {
  verdict: UsageVerdict;
  /** The id of the attempt row just written (only when the verdict is "ok"). Null when it could not be written. */
  attemptId: number | null;
}

export interface UsageStore {
  /** Checks the limits and, when they allow it, writes this request as an attempt. Called BEFORE any paid work. */
  registerAttempt(userHash: string, ipHash: string, limits: Limits, userId?: string | null): Promise<AttemptCheck>;
  /**
   * Called once, after a valuation finished successfully. Works out whether it is a repeat (this device already valued this
   * item less than 24 hours ago, measured from that first valuation) and, when it is not, turns the attempt into a counted
   * valuation. `itemKey` is null when the item is not specific enough to recognise again: then it can never be a repeat.
   */
  settleAttempt(attemptId: number | null, userHash: string, itemKey: string | null): Promise<{ repeat: boolean }>;
  /**
   * Turns an attempt into a counted valuation without asking about repeats. Used when the app was already told "not a repeat"
   * (the repeat check was too slow) and the database then said "repeat": the server follows what the app was told, so both
   * sides always agree and the user is never charged for something the server calls free.
   */
  markCounted(attemptId: number): Promise<void>;
}

export const VERDICT_MESSAGES: Record<Exclude<UsageVerdict, "ok">, string> = {
  user_limit: "You have made many valuations in a short time. Please wait a while and try again.",
  attempt_limit: "You have made many valuations in a short time. Please wait a while and try again.",
  ip_limit: "Many valuations were made from this network in a short time. Please wait a while and try again.",
  day_limit: "The service has reached its daily limit. Please try again tomorrow.",
};

/** The limit message in the person's language (English when unknown). */
export function verdictMessage(verdict: Exclude<UsageVerdict, "ok">, lang?: Lang): string {
  return T(lang).errors[verdict];
}

/** Sanitises the device id from the app. Returns null when it is missing or not a plain id. */
export function readDeviceId(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9-]{16,64}$/.test(v) ? v : null;
}
