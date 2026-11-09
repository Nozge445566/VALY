// candidate searches.
// Traps: Unicode \w and \b (lookarounds with \p{L}\p{N}_), code point slicing, null not undefined.

import type { Fingerprint } from "../../value-item/types.ts";
import { FIXED_TEMPLATES, modeTemplatesFor } from "../../value-item/fixed-templates.ts";
import { languageOf, marketplaces, soldLocal, soldWord, specialistFor } from "./data.ts";
import { itemText } from "./fingerprint.ts";
import type { Policy } from "./policy.ts";

export const SOLD_ALTS: Record<string, string[]> = {
  sv: ["slutpris", "såld", "avslutad"],
  no: ["solgt", "solgte"],
  da: ["solgt", "solgte"],
  de: ["verkauft", "zuschlag", "beendet"],
  fr: ["vendu", "prix final"],
  es: ["vendido", "precio final"],
  it: ["venduto", "prezzo finale"],
  nl: ["verkocht", "eindprijs"],
  pt: ["vendido", "preço final"],
  pl: ["sprzedane", "cena końcowa"],
  ja: ["落札", "落札価格"],
  en: ["sold listings", "completed listings", "final price", "sold price"],
};

// Python \b is Unicode-aware; JS \b is not. Lookarounds give the Python behaviour.
const B_START = "(?<![\\p{L}\\p{N}_])";
const B_END = "(?![\\p{L}\\p{N}_])";
export const SOLD_WORD = new RegExp(
  `${B_START}(sold|completed|final price|slutpris|såld|solgt|solgte|verkauft|zuschlag|vendu|vendido|venduto|verkocht|sprzedane)${B_END}|落札`,
  "iu",
);
const SITE = new RegExp(`${B_START}site:([a-z0-9.\\-]+\\.[a-z]{2,}(?:/[a-z]+)?)`, "iu");
// Python \s (no U+FEFF, plus \x1c-\x1f and \x85)
const WS = /(?:(?!\uFEFF)\s|[\x1c-\x1f\x85])+/gu;

export type Candidate = {
  templateId: string;
  query: string;
  gl: string;
  hl: string;
  site: string | null;
  origin: "fixed" | "mined" | "ident" | "learned" | "mutation";
};

export function signature(c: Candidate): [string, string, string] {
  return [c.site || "web", c.gl, c.hl.split("-")[0]];
}
export function tokens(c: Candidate): Set<string> {
  return new Set(c.query.toLowerCase().match(/[\p{L}\p{N}_:.\-]+/gu) ?? []);
}

const len = (s: string) => Array.from(s).length;

export function slug(text: string): string {
  const t = text.replace(/[^A-Za-z0-9:_.|{}-]+/g, "_").replace(/^_+|_+$/g, "");
  return Array.from(t).slice(0, 60).join("");
}

export type Slots = Record<string, string | null>;

export function slotsFor(fp: Fingerprint): Slots {
  const country = fp.country === "ZZ" ? "US" : fp.country;
  const lang = fp.language || languageOf(country);
  const local = marketplaces(country);
  return {
    item: itemText(fp),
    brand: fp.brand ?? null,
    model: fp.model ?? null,
    type: fp.type,
    category: fp.category,
    sold_local: soldLocal(lang.split("-")[0]),
    site_local: local[0] ?? null,
    site_local2: local.length > 1 ? local[1] : null,
    site_specialist: specialistFor(`${fp.category} ${fp.type}`),
  };
}

export function fill(pattern: string, slots: Slots): string | null {
  let missing = false;
  const text = pattern.replace(/\{([\p{L}\p{N}_]+)\}/gu, (_m, name: string) => {
    const value = Object.hasOwn(slots, name) ? slots[name] : null;
    if (!value) {
      missing = true;
      return "";
    }
    return value;
  });
  if (missing) return null;
  return text.replace(WS, " ").replace(/^ +| +$/g, "");
}

export function marketCodes(market: string, fp: Fingerprint): [string, string] {
  if (market === "global" || fp.country === "ZZ") return ["us", "en"];
  return [fp.country.toLowerCase(), (fp.language || "en").toLowerCase()];
}

const valid = (q: string) => len(q) >= 3 && len(q) <= 120;
function siteOf(q: string): string | null {
  const m = SITE.exec(q);
  return m ? m[1].toLowerCase() : null;
}
// Python str() for the few JSON types that can reach it.
function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  return JSON.stringify(v);
}

export function fixedCandidates(fp: Fingerprint): Candidate[] {
  const slots = slotsFor(fp);
  const out: Candidate[] = [];
  // Mode templates (retail / auction) exist only when fp.mode is set; resale gets [] so its candidates are unchanged.
  for (const t of [...modeTemplatesFor(fp), ...FIXED_TEMPLATES]) {
    const q = fill(t.pattern, slots);
    if (q && valid(q)) {
      const [gl, hl] = marketCodes(t.market, fp);
      out.push({ templateId: t.id, query: q, gl, hl, site: siteOf(q), origin: "fixed" });
    }
  }
  return out;
}

export function minedCandidates(policy: Policy, fp: Fingerprint): Candidate[] {
  const slots = slotsFor(fp);
  const out: Candidate[] = [];
  for (const t of policy.templates) {
    const q = fill(pyStr(t.pattern), slots);
    if (q && valid(q)) {
      const market = Object.hasOwn(t, "market") ? pyStr(t.market) : "global";
      const [gl, hl] = marketCodes(market, fp);
      out.push({ templateId: slug(pyStr(t.id)), query: q, gl, hl, site: siteOf(q), origin: "mined" });
    }
  }
  return out;
}

export function identCandidates(queries: string[], fp: Fingerprint): Candidate[] {
  const lang = (fp.language || "en").split("-")[0];
  const localWords = new Set<string>(lang !== "en" ? (SOLD_ALTS[lang] ?? []).map((w) => w.toLowerCase()) : []);
  localWords.add(soldLocal(lang).toLowerCase());
  const out: Candidate[] = [];
  for (const q0 of queries.slice(0, 5)) {
    const q = q0.replace(WS, " ").replace(/^ +| +$/g, "");
    if (!valid(q)) continue;
    const low = q.toLowerCase();
    const local = lang !== "en" && [...localWords].some((w) => low.includes(w));
    const sold = SOLD_WORD.test(q);
    const site = siteOf(q);
    const tid = slug(`id:${local ? "loc" : "en"}:${sold ? "sold" : "plain"}:${site || "web"}`);
    const [gl, hl] = marketCodes(local ? "local" : "global", fp);
    out.push({ templateId: tid, query: q, gl, hl, site, origin: "ident" });
  }
  return out;
}

/**
 * Variants of Haiku's own query for the guaranteed 4th slot. The first member is ALWAYS the exact Haiku query (the control,
 * keeps its old `id:` arm id so history is kept). The others use `idv:` arm ids so what is learned about them stays
 * separate from the 3 free slots. Small on purpose: add/drop the sold word, add one local marketplace hint.
 */
export function haikuVariants(control: Candidate, fp: Fingerprint): Candidate[] {
  const lang = (fp.language || "en").split("-")[0];
  const country = fp.country === "ZZ" ? "US" : fp.country;
  const out: Candidate[] = [control];
  const seen = new Set([control.query.toLowerCase()]);
  const add = (kind: string, query: string, site: string | null, gl: string, hl: string) => {
    const q = query.replace(WS, " ").replace(/^ +| +$/g, "");
    if (!valid(q) || seen.has(q.toLowerCase())) return;
    seen.add(q.toLowerCase());
    out.push({ templateId: slug(`idv:${kind}`), query: q, gl, hl, site, origin: "ident" });
  };
  if (SOLD_WORD.test(control.query)) add("drop_sold", control.query.replace(SOLD_WORD, " "), control.site, control.gl, control.hl);
  else add(`add_sold:${lang}`, `${control.query} ${soldLocal(lang)}`, control.site, control.gl, control.hl);
  const local = marketplaces(country)[0];
  if (local && !control.site) {
    const [gl, hl] = marketCodes("local", fp);
    add(`site:${local}`, `${control.query} site:${local}`, local, gl, hl);
  }
  return out;
}

export function learnedSiteCandidates(policy: Policy, fp: Fingerprint): Candidate[] {
  const country = fp.country;
  if (country === "ZZ") return [];
  const slots = slotsFor(fp);
  const item = slots.item || fp.type;
  const ownLang = (fp.language || "en").split("-")[0];
  const out: Candidate[] = [];
  (policy.sites.get(country) ?? []).slice(0, 3).forEach((entry, idx) => {
    const i = idx + 1;
    const site = String(entry.site);
    const gl = String(entry.gl || "us").toLowerCase();
    if (!/^[a-z]{2}$/.test(gl)) return;
    let hl: string;
    if (gl === country.toLowerCase()) hl = ownLang;
    else if (gl !== "us") hl = languageOf(gl.toUpperCase()).split("-")[0];
    else hl = "en";
    const query = `${item} ${soldWord(hl)} site:${site}`;
    if (valid(query)) out.push({ templateId: `site_learned_${i}`, query, gl, hl, site, origin: "learned" });
  });
  return out;
}

export function mutationCandidates(fp: Fingerprint): Candidate[] {
  const slots = slotsFor(fp);
  const item = slots.item || fp.type;
  const country = fp.country === "ZZ" ? "US" : fp.country;
  const lang = (fp.language || "en").split("-")[0];
  const out: Candidate[] = [];
  if (lang !== "en") {
    const [gl, hl] = marketCodes("local", fp);
    for (const word of SOLD_ALTS[lang] ?? [])
      out.push({ templateId: slug(`mut:lang:${lang}:${word}`), query: `${item} ${word}`, gl, hl, site: null, origin: "mutation" });
  }
  for (const word of SOLD_ALTS.en)
    out.push({ templateId: slug(`mut:syn:${word}`), query: `${item} ${word}`, gl: "us", hl: "en", site: null, origin: "mutation" });
  const sites = [...marketplaces(country)];
  const spec = slots.site_specialist;
  if (spec) sites.push(spec);
  sites.push("ebay.com");
  for (const site of new Set(sites)) {
    const localSite = marketplaces(country).includes(site);
    const [gl, hl] = marketCodes(localSite ? "local" : "global", fp);
    out.push({ templateId: slug(`mut:site:${site}`), query: `${item} sold site:${site}`, gl, hl, site, origin: "mutation" });
  }
  return out.filter((c) => valid(c.query));
}
