import type { Fingerprint, PlannedSearch, SearchPlan } from "../types.ts";
import { LETTERS_ONLY, OPERATOR_WORDS, type Proposal, QUOTE_TEST, baseRecord, norm, protectedParts, wordsOf } from "./r1.ts";
import { RULE_ROLE } from "./model.ts";
import { planKeepsRules } from "./invariants.ts";

// ---------------------------------------------------------------- RG and RH: remove a repeated word

/**
 * The query without its repeated words (the first occurrence stays). Operators, words with digits or punctuation, quote
 * marks and site: parts are never touched, and a word that repeats inside the brand or model itself ("Bora Bora") stays.
 */
export function withoutRepeatedWords(query: string, fp: Fingerprint): string {
  const own = new Set<string>();
  for (const text of [fp.brand, fp.model]) {
    const seen = new Set<string>();
    for (const w of wordsOf(text)) {
      if (seen.has(w)) own.add(w);
      seen.add(w);
    }
  }
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const t of query.split(/\s+/).filter(Boolean)) {
    const low = t.toLowerCase();
    const plain = LETTERS_ONLY.test(t) && t.length >= 2 && !OPERATOR_WORDS.has(low);
    if (plain && !own.has(low) && seen.has(low)) continue;
    if (plain) seen.add(low);
    kept.push(t);
  }
  return kept.join(" ");
}

const tokenSet = (q: string) => new Set(q.toLowerCase().split(/\s+/).filter(Boolean));

/**
 * RG (global template searches) and RH (Haiku's own search). The same tiny, safe edit for both: remove a repeated word.
 * Nothing is added, nothing distinct is removed (the set of words must be identical afterwards, so the local name can
 * never be lost), site:, quotes and the sold word stay exactly as they were. Pure. Never changes the number of searches.
 */
export function proposeTidy(plan: SearchPlan, fp: Fingerprint, haikuQueries: readonly string[], rule: "RG" | "RH"): Proposal {
  const role = RULE_ROLE[rule];
  const lang = (fp.language || "").toLowerCase().split("-")[0];
  const records = plan.searches.map((s) => baseRecord(s, null, fp, haikuQueries));
  const out: PlannedSearch[] = plan.searches.map((s) => ({ ...s }));
  const taken = new Set(plan.searches.map((s) => s.query.toLowerCase()));
  let changes = 0;

  plan.searches.forEach((s, i) => {
    const rec = records[i];
    if (rec.role !== role) return void (rec.skipped = "other_role");
    if (QUOTE_TEST.test(s.query)) return void (rec.skipped = "has_quotes");
    const next = withoutRepeatedWords(s.query, fp).replace(/\s+/g, " ").trim();
    if (norm(next) === norm(s.query)) return void (rec.skipped = "no_repeated_word");
    if (next.length < 3 || next.length > 120) return void (rec.skipped = "length");
    if (protectedParts(next, lang) !== protectedParts(s.query, lang)) return void (rec.skipped = "protected_part_changed");
    const before = tokenSet(s.query);
    const after = tokenSet(next);
    if (before.size !== after.size || [...before].some((t) => !after.has(t))) return void (rec.skipped = "word_lost");
    if (taken.has(next.toLowerCase())) return void (rec.skipped = "duplicate");
    taken.delete(s.query.toLowerCase());
    taken.add(next.toLowerCase());
    out[i] = { ...s, query: next };
    rec.proposed_query = next;
    rec.executed_query = next;
    rec.rule = rule;
    changes++;
  });

  if (changes > 0 && !planKeepsRules(plan, { ...plan, searches: out })) {
    return { searches: plan.searches, records: plan.searches.map((s) => baseRecord(s, "invariant_failed", fp, haikuQueries)), haikuQuery: null, localName: null, changes: 0 };
  }
  return { searches: out, records, haikuQuery: null, localName: null, changes };
}
