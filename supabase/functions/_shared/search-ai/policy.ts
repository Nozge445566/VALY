// the learned policy. Schema 1, no key changes.
// Map inside; plain objects only when writing JSON. Never undefined: null.

export const SCHEMA = 1;
export const DEFAULT_PRIOR_RATE = 0.4;
export const DEFAULT_PRIOR_STRENGTH = 6.0;

export type Stat = [number, number, number]; // [k, t, n]
export type SiteStat = { site: string; gl: string; kept: number; n: number };

export type Policy = {
  version: number; // 0 = no learned policy yet
  arms: Map<string, Map<string, Stat>>;
  templates: Array<Record<string, unknown>>;
  priorRate: number;
  priorStrength: number;
  training: Record<string, unknown>;
  sites: Map<string, SiteStat[]>;
};

export function emptyPolicy(version = 0): Policy {
  return {
    version,
    arms: new Map(),
    templates: [],
    priorRate: DEFAULT_PRIOR_RATE,
    priorStrength: DEFAULT_PRIOR_STRENGTH,
    training: {},
    sites: new Map(),
  };
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
// Python isinstance(x, (int, float)) is also true for bool.
function isNum(x: unknown): x is number | boolean {
  return (typeof x === "number" && Number.isFinite(x)) || typeof x === "boolean";
}
function num(x: unknown, dflt: number): number {
  return isNum(x) ? Number(x) : dflt;
}
function deepCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** policy.py Policy.from_json */
export function policyFromJson(version: number, raw: unknown): Policy {
  if (!isDict(raw) || raw.schema !== SCHEMA) return emptyPolicy(0);
  const prior = isDict(raw.prior) ? raw.prior : {};
  const arms = new Map<string, Map<string, Stat>>();
  const rawArms = isDict(raw.arms) ? raw.arms : {};
  for (const [ctx, per] of Object.entries(rawArms)) {
    if (!isDict(per)) continue;
    const m = new Map<string, Stat>();
    arms.set(String(ctx), m);
    for (const [tid, stat] of Object.entries(per)) {
      if (Array.isArray(stat) && stat.length === 3 && stat.every(isNum)) {
        m.set(String(tid), [Number(stat[0]), Number(stat[1]), Number(stat[2])]);
      }
    }
  }
  const templates = (Array.isArray(raw.templates) ? raw.templates : []).filter(
    (t): t is Record<string, unknown> => isDict(t) && "id" in t && "pattern" in t,
  );
  const sites = new Map<string, SiteStat[]>();
  if (isDict(raw.sites)) {
    for (const [country, lst] of Object.entries(raw.sites)) {
      if (!Array.isArray(lst)) continue;
      const good: SiteStat[] = lst
        .filter((x): x is Record<string, unknown> => isDict(x) && typeof x.site === "string")
        .map((x) => ({
          site: String(x.site),
          gl: String(x.gl ?? "us"),
          kept: num(x.kept, 0),
          n: Math.trunc(num(x.n, 0)),
        }));
      if (good.length) sites.set(String(country).toUpperCase(), good);
    }
  }
  return {
    version,
    arms,
    templates,
    priorRate: num(prior.rate, DEFAULT_PRIOR_RATE),
    priorStrength: num(prior.strength, DEFAULT_PRIOR_STRENGTH),
    training: isDict(raw.training) ? raw.training : {},
    sites,
  };
}

/** policy.py Policy.to_json: plain objects, same keys. */
export function policyToJson(p: Policy): Record<string, unknown> {
  const arms: Record<string, Record<string, number[]>> = {};
  for (const [ctx, per] of p.arms) {
    arms[ctx] = {};
    for (const [tid, s] of per) arms[ctx][tid] = [...s];
  }
  const sites: Record<string, SiteStat[]> = {};
  for (const [c, l] of p.sites) sites[c] = deepCopy(l);
  return {
    schema: SCHEMA,
    arms,
    templates: deepCopy(p.templates),
    prior: { rate: p.priorRate, strength: p.priorStrength },
    training: deepCopy(p.training),
    sites,
  };
}

/** Searches seen in total (the global context). */
export function observations(p: Policy): number {
  let sum = 0;
  for (const s of p.arms.get("g")?.values() ?? []) sum += s[2];
  return Math.trunc(sum);
}

/** [sold_per_search, n] for this country, or null. */
export function countryStat(p: Policy, country: string): [number, number] | null {
  const cs = p.training.country_stats;
  const stat = isDict(cs) ? cs[country.toUpperCase()] : undefined;
  if (!isDict(stat)) return null;
  const a = stat.sold_per_search;
  const b = stat.n;
  if (a === undefined || a === null || b === undefined || b === null) return null;
  const x = Number(a);
  const n = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(n)) return null;
  return [x, Math.trunc(n)];
}
