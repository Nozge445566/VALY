// Lookup of the learned width multiplier k (table l_calibration). Pure function: no network, no randomness.
// The Brain reads the table at the start of a request; a missing bucket means null (the engine then uses 1).

/** Parent chain: category|strength|basis|mode -> category|strength|basis -> category|strength -> strength -> global -> null. */
export function parentOf(bucket: string): string | null {
  if (bucket === "global") return null;
  const parts = bucket.split("|");
  if (parts.length >= 4) return `${parts[0]}|${parts[1]}|${parts[2]}`; // mode bucket -> same bucket without mode
  if (parts.length === 3) return `${parts[0]}|${parts[1]}`;
  if (parts.length === 2) return parts[1];
  return "global";
}

/** Looks k up along the parent chain. A missing bucket means null (the engine then uses 1). */
export function lookupK(table: ReadonlyMap<string, number>, bucket: string): number | null {
  let b: string | null = bucket;
  while (b !== null) {
    const k = table.get(b);
    if (k !== undefined) return k;
    b = parentOf(b);
  }
  return null;
}
