// Fixed search templates. Diagram: "Fixed search templates as fallback" and
// "Fallback and safety: fixed templates take over if the Search AI errors, is slow, or has no data."
//
// These are the same templates the Search AI starts from
// (search-ai/searchai/fixed_templates.json). A test keeps the two lists identical.

import { HARD_CAPS } from "./config.ts";
import { languageOf, MARKETPLACES, specialistFor } from "./markets.ts";
import type { Fingerprint, PlannedSearch, SearchPlan } from "./types.ts";

export interface FixedTemplate {
  id: string;
  /** Slots: {item} {category} {sold_local} {site_local} {site_specialist}. */
  pattern: string;
  /** "global": aimed at the US / English web. "local": the user's country and language. */
  market: "global" | "local";
  needs: string[];
}

export const FIXED_TEMPLATES: FixedTemplate[] = [
  { id: "fx_ebay_sold", pattern: "{item} sold ebay", market: "global", needs: ["item"] },
  { id: "fx_local_sold", pattern: "{item} {sold_local}", market: "local", needs: ["item", "sold_local"] },
  { id: "fx_local_site", pattern: "{item} site:{site_local}", market: "local", needs: ["item", "site_local"] },
  { id: "fx_specialist", pattern: "{item} sold site:{site_specialist}", market: "global", needs: ["item", "site_specialist"] },
  { id: "fx_ebay_completed", pattern: "{item} \"sold\" site:ebay.com", market: "global", needs: ["item"] },
  { id: "fx_local_ebay", pattern: "{item} sold site:{site_local}", market: "local", needs: ["item", "site_local"] },
];

/** Templates for NON-resale modes only (fp.mode set). They go first; resale plans never see them, so every resale plan stays identical.
 * Not part of FIXED_TEMPLATES on purpose: a test keeps that list identical to the Search AI's fixed_templates.json. */
export const MODE_TEMPLATES: Record<"retail" | "auction", FixedTemplate[]> = {
  retail: [{ id: "fx_retail_price", pattern: "{item} price", market: "global", needs: ["item"] }],
  auction: [
    { id: "fx_hammer_price", pattern: "{item} hammer price", market: "global", needs: ["item"] },
    { id: "fx_price_realized", pattern: "{item} price realized", market: "global", needs: ["item"] },
  ],
};
export function modeTemplatesFor(fp: Fingerprint): FixedTemplate[] {
  return fp.mode ? MODE_TEMPLATES[fp.mode] ?? [] : [];
}

export const SOLD_LOCAL: Record<string, string> = {
  sv: "såld slutpris", no: "solgt", da: "solgt", de: "verkauft", fr: "vendu", es: "vendido",
  it: "venduto", nl: "verkocht", pt: "vendido", pl: "sprzedane", ja: "落札", en: "sold",
};

export function itemText(fp: Fingerprint): string {
  const parts = [fp.brand, fp.model ?? fp.type].filter((p): p is string => Boolean(p));
  const text = parts.join(" ").trim() || fp.type;
  return text.replace(/\s+/g, " ").slice(0, 80);
}

function fill(pattern: string, slots: Record<string, string | null>): string | null {
  let missing = false;
  const text = pattern.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = slots[name];
    if (!v) {
      missing = true;
      return "";
    }
    return v;
  });
  return missing ? null : text.replace(/\s+/g, " ").trim();
}

/**
 * The fixed plan: up to 4 diverse searches. Identification's own Google queries fill the
 * places the templates cannot (for example when the item has no clear brand).
 */
export function fixedPlan(fp: Fingerprint, identQueries: string[]): SearchPlan {
  const country = fp.country === "ZZ" ? "US" : fp.country.toUpperCase();
  const lang = fp.language || languageOf(country);
  const local = MARKETPLACES[country] ?? [];
  const slots: Record<string, string | null> = {
    item: itemText(fp),
    category: fp.category,
    sold_local: SOLD_LOCAL[lang] ?? "sold",
    site_local: local[0] ?? null,
    site_specialist: specialistFor(`${fp.category} ${fp.type}`),
  };

  const searches: PlannedSearch[] = [];
  const seen = new Set<string>();
  const push = (query: string, template_id: string, global: boolean) => {
    const key = query.toLowerCase();
    if (searches.length >= HARD_CAPS.searches || seen.has(key) || query.length < 3 || query.length > 120) return;
    seen.add(key);
    searches.push({
      id: `s${searches.length + 1}`,
      query,
      template_id,
      kind: "fixed",
      gl: global ? "us" : country.toLowerCase(),
      hl: global ? "en" : lang.toLowerCase(),
    });
  };

  for (const t of [...modeTemplatesFor(fp), ...FIXED_TEMPLATES]) {
    const q = fill(t.pattern, slots);
    if (q) push(q, t.id, t.market === "global");
    if (searches.length >= 3) break;
  }
  identQueries.forEach((q, i) => push(q.replace(/\s+/g, " ").trim(), `id_fixed_${i + 1}`, false));
  for (const t of [...modeTemplatesFor(fp), ...FIXED_TEMPLATES]) {
    const q = fill(t.pattern, slots);
    if (q) push(q, t.id, t.market === "global");
  }

  return {
    strategyVersion: null,
    source: "fixed",
    searches,
    stop: { soldPrices: HARD_CAPS.soldPrices, maxMs: HARD_CAPS.searchMs },
  };
}
