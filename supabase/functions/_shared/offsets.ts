// Learned price level and foreign noise per country pair (origin -> user), read from l_price_offsets. Pure functions:
// no network, no randomness. The Brain reads the table at the start of a request (cached 10 minutes).
// A foreign listing can sit at another LEVEL than the user's market; a row holds the ln shift and the extra noise of a pair.
// Rows are re-checked on the way in: the shift is clamped, and a row with too few reports counts for nothing.
// The offset moves only what the interval engine reads. The Judge still sees real listing prices.

import { FOREIGN_STD_MIN_REPORTS, OFFSET_CLAMP, OFFSET_MIN_REPORTS } from "../value-item/interval.config.ts";

const COUNTRY = /^[A-Z]{2}$/;

/** One row of l_price_offsets. */
export interface OffsetRow {
  origin: string;
  user_country: string;
  /** ln price shift to add to a foreign price of this origin for this user, or null (not enough reports for a shift). */
  offset_ln: number | null;
  /** Learned noise (ln price) of the pair, or null. Never used below the guessed FOREIGN_STD. */
  extra_std: number | null;
  /** Valuations the row rests on. */
  n: number;
  /** The local baseline that was subtracted (ln price). */
  baseline_ln: number | null;
}

export type OffsetTable = ReadonlyMap<string, { offsetLn: number | null; extraStd: number | null; n: number }>;

export const pairKey = (origin: string, user: string) => `${origin.toUpperCase()}>${user.toUpperCase()}`;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** What the database gives us, as a table the engine can read. Malformed rows are skipped. */
export function parseOffsetRows(raw: unknown): OffsetRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OffsetRow[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const x = r as Record<string, unknown>;
    const origin = typeof x.origin === "string" ? x.origin.trim().toUpperCase() : "";
    const user = typeof x.user_country === "string" ? x.user_country.trim().toUpperCase() : "";
    const n = num(x.n);
    if (!COUNTRY.test(origin) || !COUNTRY.test(user) || origin === user || n === null || n < 0) continue;
    const offset = x.offset_ln === null || x.offset_ln === undefined ? null : num(x.offset_ln);
    const std = x.extra_std === null || x.extra_std === undefined ? null : num(x.extra_std);
    const baseline = x.baseline_ln === null || x.baseline_ln === undefined ? null : num(x.baseline_ln);
    out.push({ origin, user_country: user, offset_ln: offset, extra_std: std, n, baseline_ln: baseline });
  }
  return out;
}

export function offsetTable(rows: readonly OffsetRow[]): OffsetTable {
  return new Map(
    rows.map((r) => [
      pairKey(r.origin, r.user_country),
      {
        // Re-checked on the way in: even a hand-edited row cannot push a price further than the clamp,
        // and a row with too few reports counts for nothing.
        offsetLn: r.offset_ln !== null && r.n >= OFFSET_MIN_REPORTS ? clamp(r.offset_ln, -OFFSET_CLAMP, OFFSET_CLAMP) : null,
        extraStd: r.extra_std !== null && r.n >= FOREIGN_STD_MIN_REPORTS ? r.extra_std : null,
        n: r.n,
      },
    ]),
  );
}

/** What the engine needs for one foreign listing: the shift and the noise of its pair, or null (no evidence). */
export function lookupOffset(
  table: OffsetTable | undefined,
  origin: string | undefined,
  user: string | null | undefined,
): { shiftLn: number; extraStd: number | null } | null {
  if (!table || !origin || !user) return null;
  const o = origin.toUpperCase();
  const u = user.toUpperCase();
  if (!COUNTRY.test(o) || !COUNTRY.test(u) || o === u || u === "ZZ") return null;
  const hit = table.get(pairKey(o, u));
  if (!hit || (hit.offsetLn === null && hit.extraStd === null)) return null;
  return { shiftLn: hit.offsetLn ?? 0, extraStd: hit.extraStd };
}
