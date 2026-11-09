// Neighbour prior (rung 4 of the estimate ladder). PURE. Turns the saved results of SIMILAR past scans (same
// category and brand, newest Brain version only) into ONE weak ln-USD source for the fused engine: "items like this usually sold
// around X". It is deliberately wide (sd floor 0.3, wider when only the brand matches), needs at least MIN_NEIGHBOURS rows, and the
// fusion TEMPERS it when it contradicts the ads, so it can steady a thin market but never overrule real ads.
// Caveat: it is built from our own earlier outputs, not from independent truth. Do not give it a small sd.
import { median, weightedMedian } from "./stats.ts";
import { isTrustedBrainVersion } from "./memory.ts";

export const MIN_NEIGHBOURS = 3;
export const MAX_NEIGHBOURS = 40;
export const NEIGHBOUR_SD_FLOOR = 0.3;
export const NEIGHBOUR_SD_CAP = 1.0;
export const BRAND_ONLY_EXTRA_SD = 0.15; // the model did not match, only category + brand
export const NEIGHBOUR_HALF_LIFE_DAYS = 90;
export const NEIGHBOUR_MIN_CONFIDENCE = 30;

export interface NeighbourRow {
  /** mid price of the saved result, ALREADY converted to USD by the store (null = could not be converted: row is dropped) */
  midUsd: number | null;
  confidence: number | null;
  createdAt: string;
  brainVersion?: string | null;
  /** true when the saved scan had the same model as this one, false when only category + brand matched */
  sameModel: boolean;
}

export interface NeighbourSource { name: "neighbours"; mu: number; sd: number; n: number }

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function neighbourSource(rows: readonly NeighbourRow[], nowMs: number): NeighbourSource | null {
  const ys: number[] = [], ws: number[] = [];
  let modelShare = 0;
  for (const r of rows.slice(0, MAX_NEIGHBOURS)) {
    if (!r || !fin(r.midUsd) || r.midUsd <= 0 || !isTrustedBrainVersion(r.brainVersion)) continue;
    if (!fin(r.confidence) || r.confidence < NEIGHBOUR_MIN_CONFIDENCE) continue;
    const t = Date.parse(r.createdAt);
    if (!Number.isFinite(t) || t > nowMs + 60_000) continue;
    const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
    ys.push(Math.log(r.midUsd));
    ws.push(Math.pow(0.5, ageDays / NEIGHBOUR_HALF_LIFE_DAYS) * (r.sameModel ? 1.5 : 1) * (r.confidence / 100));
    if (r.sameModel) modelShare += 1;
  }
  if (ys.length < MIN_NEIGHBOURS) return null;
  const mu = weightedMedian(ys, ws);
  const mad = 1.4826 * median(ys.map((y) => Math.abs(y - mu)));
  const share = modelShare / ys.length;
  const sd = Math.min(NEIGHBOUR_SD_CAP, Math.sqrt(Math.max(NEIGHBOUR_SD_FLOOR ** 2, mad ** 2 + 0.09 * (1 - share) ** 2) + (share < 0.5 ? BRAND_ONLY_EXTRA_SD ** 2 : 0)));
  if (!fin(mu) || !fin(sd)) return null;
  return { name: "neighbours", mu, sd: Math.max(NEIGHBOUR_SD_FLOOR, sd), n: ys.length };
}
