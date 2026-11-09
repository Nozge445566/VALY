import type { SearchPlan } from "../types.ts";

/** The rules a Connector-changed plan must keep. */
export function planKeepsRules(before: SearchPlan, after: SearchPlan): boolean {
  if (before.searches.length !== after.searches.length) return false;
  const seen = new Set<string>();
  for (let i = 0; i < before.searches.length; i++) {
    const a = before.searches[i];
    const b = after.searches[i];
    if (a.id !== b.id || a.kind !== b.kind || a.template_id !== b.template_id || a.gl !== b.gl || a.hl !== b.hl || a.tier !== b.tier) return false;
    if (!/^[A-Za-z0-9:_.|{}-]{1,80}$/.test(b.template_id)) return false;
    if (b.query.length < 3 || b.query.length > 120 || b.query !== b.query.trim().replace(/\s+/g, " ")) return false;
    const key = b.query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return after.strategyVersion === before.strategyVersion && after.source === before.source && after.stop === before.stop;
}
