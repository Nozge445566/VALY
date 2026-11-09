import type { Fingerprint } from "../types.ts";

// ---------------------------------------------------------------- buckets and the learned dial

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "unknown";
}

/** Bucket = country | category | plan source. The learner writes a dial per bucket and per parent. */
export function connectorBucket(fp: Fingerprint, source: "search_ai" | "fixed"): string {
  const country = /^[A-Za-z]{2}$/.test(fp.country) ? fp.country.toUpperCase() : "ZZ";
  return `${country}|${slug(fp.category)}|${source}`;
}

/** The bucket and its parents, most specific first: `SE|watch|fixed`, `SE|watch`, `SE`. */
export function bucketChain(bucket: string): string[] {
  const parts = bucket.split("|");
  const chain: string[] = [];
  for (let n = parts.length; n >= 1; n--) chain.push(parts.slice(0, n).join("|"));
  return chain;
}

/** The most specific learned dial for a bucket, or null. A missing row means "nothing learned". */
export function dialFor(table: ReadonlyMap<string, number> | undefined, bucket: string): number | null {
  if (!table) return null;
  for (const b of bucketChain(bucket)) {
    const d = table.get(b);
    if (d !== undefined && Number.isFinite(d)) return Math.min(1, Math.max(0, d));
  }
  return null;
}
