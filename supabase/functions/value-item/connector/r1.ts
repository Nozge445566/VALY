import { type ConnectorSearchRecord, LOCAL_NAME_MAX_WORDS, NO_SPACE_LANGUAGES, type SearchRole } from "./model.ts";
import { FIXED_TEMPLATES, itemText } from "../fixed-templates.ts";
import type { Fingerprint, PlannedSearch, SearchPlan } from "../types.ts";
import { MARKETPLACES, SPECIALISTS } from "../markets.ts";
import { SOLD_WORD } from "../market-tiers.ts";
import { planKeepsRules } from "./invariants.ts";

// ---------------------------------------------------------------- R1: the local name

const ALL_SOLD_WORDS: ReadonlySet<string> = new Set(
  [...Object.values(SOLD_WORD), "sold", "ebay", "completed"].flatMap((w) => w.toLowerCase().split(/\s+/)),
);

/** Marketplace and specialist-site names ("tradera", "chrono24"): noise inside a Haiku query, never part of an item name. */
const SITE_LABELS: ReadonlySet<string> = new Set(
  [...Object.values(MARKETPLACES).flat(), ...SPECIALISTS.map((s) => s.site)].map((host) => host.split(/[./]/)[0].toLowerCase()),
);

const QUOTES = /["'\u201C\u201D\u201E\u2018\u2019\u00AB\u00BB]/g;
export const QUOTE_TEST = /["'\u201C\u201D\u201E\u2018\u2019\u00AB\u00BB]/;
/** Google operator words: never part of an item name. */
export const OPERATOR_WORDS: ReadonlySet<string> = new Set(["or", "and", "not", "intitle", "inurl", "site", "filetype"]);
export const LETTERS_ONLY = /^[\p{L}\p{M}]+$/u;

export const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function wordsOf(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/**
 * The local name hidden in one Haiku query, or null. Remove the brand and model words, every known sold word, any
 * site: part, quote marks and marketplace names; what is left must be 1 to 4 words, letters only (å ä ö ü work), and
 * not the English type. Anything else: null (do nothing).
 */
export function localNameFrom(query: string, fp: Fingerprint): string | null {
  const known = new Set([...wordsOf(fp.brand), ...wordsOf(fp.model)]);
  const stripped = query.replace(/\bsite:\S+/gi, " ").replace(QUOTES, " ");
  const kept = stripped
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => {
      const low = t.toLowerCase();
      return !known.has(low) && !ALL_SOLD_WORDS.has(low) && !SITE_LABELS.has(low);
    });
  if (kept.length < 1 || kept.length > LOCAL_NAME_MAX_WORDS) return null;
  if (!kept.every((t) => LETTERS_ONLY.test(t) && t.length >= 2 && !OPERATOR_WORDS.has(t.toLowerCase()))) return null; // digits, operators, one-letter junk
  const name = kept.join(" ");
  if (norm(name) === norm(fp.type)) return null; // Haiku just wrote the English type
  return name;
}

/** Does the market language allow R1 at all? */
function languageAllowsR1(fp: Fingerprint): boolean {
  const base = (fp.language || "").toLowerCase().split("-")[0];
  if (!base || base === "en" || NO_SPACE_LANGUAGES.has(base)) return false;
  return base in SOLD_WORD; // unknown language: the sold-word removal cannot be trusted
}

function isHaikuSearch(s: PlannedSearch, haikuQueries: readonly string[]): boolean {
  return /^id_fixed_\d+$/.test(s.template_id) || s.template_id.startsWith("id:") || s.template_id.startsWith("idv:") || haikuQueries.some((q) => norm(q) === norm(s.query));
}

/** Position of `needle` inside `hay` as a whole phrase (not inside another word), case-insensitive. -1 if absent. */
function phraseIndex(hay: string, needle: string): number {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return -1;
  let from = 0;
  for (;;) {
    const i = h.indexOf(n, from);
    if (i < 0) return -1;
    const before = i === 0 ? " " : h[i - 1];
    const after = i + n.length >= h.length ? " " : h[i + n.length];
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return i;
    from = i + 1;
  }
}

/** What must stay exactly as it was inside a query: site: parts, quote marks and the sold word. */
export function protectedParts(q: string, lang: string): string {
  const sites = (q.match(/\bsite:\S+/gi) ?? []).map((x) => x.toLowerCase()).join(",");
  const quotes = (q.match(QUOTES) ?? []).join("");
  const sold = SOLD_WORD[lang] ? (phraseIndex(q, SOLD_WORD[lang]) >= 0 ? "1" : "0") : "-";
  return `${sites}#${quotes}#${sold}`;
}

/** Which kind of search this is. Haiku's own first; then the template's market; unknown templates by their gl. */
export function roleOf(s: PlannedSearch, fp: Fingerprint, haikuQueries: readonly string[]): SearchRole {
  if (isHaikuSearch(s, haikuQueries)) return "haiku";
  const t = FIXED_TEMPLATES.find((x) => x.id === s.template_id);
  if (t) return t.market === "local" ? "local" : "global";
  const country = /^[A-Za-z]{2}$/.test(fp.country) ? fp.country.toLowerCase() : "";
  return s.gl.toLowerCase() === country ? "local" : "global";
}

export function baseRecord(s: PlannedSearch, skipped: string | null, fp: Fingerprint, haikuQueries: readonly string[]): ConnectorSearchRecord {
  return {
    id: s.id,
    template_id: s.template_id,
    original_query: s.query,
    proposed_query: s.query,
    executed_query: s.query,
    rule: null,
    role: roleOf(s, fp, haikuQueries),
    rule_on: null,
    rule_draw: null,
    rule_dial: null,
    rule_share: null,
    skipped,
    is_haiku: isHaikuSearch(s, haikuQueries),
  };
}

export interface Proposal {
  searches: PlannedSearch[];
  records: ConnectorSearchRecord[];
  haikuQuery: string | null;
  localName: string | null;
  changes: number;
}

/** R1. Pure. Returns the proposed searches and one record per search. Never changes the number or order of searches. */
export function proposeR1(plan: SearchPlan, fp: Fingerprint, haikuQueries: readonly string[]): Proposal {
  const base = (s: PlannedSearch, skipped: string | null) => baseRecord(s, skipped, fp, haikuQueries);
  const none = (why: string, haikuQuery: string | null = null): Proposal => ({
    searches: plan.searches,
    records: plan.searches.map((s) => base(s, isHaikuSearch(s, haikuQueries) ? "haiku_search" : why)),
    haikuQuery,
    localName: null,
    changes: 0,
  });

  const country = /^[A-Za-z]{2}$/.test(fp.country) ? fp.country.toUpperCase() : "ZZ";
  if (country === "ZZ") return none("country_unknown");
  if (fp.model && fp.model.trim()) return none("has_model"); // brand + model is language-neutral
  if (!languageAllowsR1(fp)) return none("language");
  if (haikuQueries.length === 0) return none("no_haiku_query");

  // The local name must be the same whichever Haiku query it comes from (Identification writes exactly one).
  const found = new Map<string, string>(); // name (lower) -> the query it came from
  for (const q of haikuQueries) {
    const name = localNameFrom(q, fp);
    if (name) found.set(name.toLowerCase(), q);
  }
  if (found.size !== 1) return none(found.size === 0 ? "no_local_name" : "ambiguous_local_name");
  const [[, haikuQuery]] = [...found.entries()];
  const localName = localNameFrom(haikuQuery, fp) as string;

  const english = itemText(fp); // "Brand type", or just "type"
  const replacement = [fp.brand, localName].filter((p): p is string => Boolean(p)).join(" ");
  const lang = fp.language.toLowerCase().split("-")[0];
  const gl = country.toLowerCase();

  const out: PlannedSearch[] = plan.searches.map((s) => ({ ...s }));
  const records = plan.searches.map((s) => base(s, null));
  let changes = 0;
  const taken = new Set(plan.searches.map((s) => s.query.toLowerCase()));

  plan.searches.forEach((s, i) => {
    const rec = records[i];
    if (rec.is_haiku) return void (rec.skipped = "haiku_search");
    if (s.gl !== gl) return void (rec.skipped = "not_local");
    if (QUOTE_TEST.test(s.query)) return void (rec.skipped = "has_quotes");
    const at = phraseIndex(s.query, english);
    if (at < 0) return void (rec.skipped = "no_english_item_text");
    if (phraseIndex(s.query, localName) >= 0) return void (rec.skipped = "name_already_present");
    const next = `${s.query.slice(0, at)}${replacement}${s.query.slice(at + english.length)}`.replace(/\s+/g, " ").trim();
    if (next.length < 3 || next.length > 120) return void (rec.skipped = "length");
    if (protectedParts(next, lang) !== protectedParts(s.query, lang)) return void (rec.skipped = "protected_part_changed");
    if (norm(next) === norm(s.query)) return void (rec.skipped = "no_change");
    // The result must not equal another search of the plan (for example Haiku's own query): that search would be wasted.
    if (taken.has(next.toLowerCase())) return void (rec.skipped = "duplicate");
    taken.delete(s.query.toLowerCase());
    taken.add(next.toLowerCase());
    out[i] = { ...s, query: next };
    rec.proposed_query = next;
    rec.executed_query = next;
    rec.rule = "R1";
    changes++;
  });

  // The whole proposal must be a legal plan. If not: no change at all (never half a change).
  if (changes > 0 && !planKeepsRules(plan, { ...plan, searches: out })) {
    return { ...none("invariant_failed", haikuQuery), localName };
  }
  return { searches: out, records, haikuQuery, localName, changes };
}
