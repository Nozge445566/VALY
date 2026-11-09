import type { AuthenticityReport, DetailReport, PlannedSearch, SearchPlan } from "../types.ts";



/**
 * Authenticity eye -> Market Live (the Detail eye NEVER reaches Market Live: only Memory and the Judge). Builds the ONE concrete
 * eye query: the plan's first query + the Authenticity eye's search terms (era, rarity, construction), else its era. It is NOT a
 * fifth search: Market Live runs it only when the market is thin after the first wave, in place of the weakest Search-AI search
 * (see market-live.ts). Pure. Returns the plan unchanged when there is nothing new to add.
 */
export function withEyeSearch(plan: SearchPlan, _details: DetailReport | null, auth: AuthenticityReport | null): SearchPlan {
  if (plan.searches.length === 0) return plan;
  const base = plan.searches[0];
  const have = base.query.toLowerCase();
  const terms: string[] = [];
  const add = (t: string | null | undefined) => {
    const v = (t ?? "").trim();
    if (v && !have.includes(v.toLowerCase()) && !terms.some((x) => x.toLowerCase() === v.toLowerCase())) terms.push(v);
  };
  for (const t of auth?.search_terms ?? []) add(t);
  add(auth?.era);
  if (terms.length === 0) return plan; // a byte-identical query would only return duplicates
  const reason = "eyes_evidence";
  const query = `${base.query} ${terms.slice(0, 3).join(" ")}`.replace(/\s+/g, " ").trim().slice(0, 120);
  const all = [...plan.searches, ...(plan.extraSearches ?? [])];
  const used = new Set(all.map((s) => s.id));
  const id = ["s5", "s6", "s7", "s8"].find((x) => !used.has(x)) ?? "s5x";
  const extra: PlannedSearch = { id, query, template_id: "eyes_evidence", kind: "fixed", gl: base.gl, hl: base.hl, reason };
  return { ...plan, extraSearches: [...(plan.extraSearches ?? []), extra] };
}
