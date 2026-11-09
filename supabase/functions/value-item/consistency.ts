// Consistency adjudicator (spec 1.4 item 3). PURE and deterministic: cross-checks the Judge's per-ad labels and risk against
// the findings, the Identification and the eyes. Every rule is a table row in RULES with a test. Each disagreement is
// returned so it can become a width driver and lower confidence. It never invents a number: it only demotes a label,
// forces "different", or raises a risk by one notch.

import type { AdLabel, AdMatch, AuthenticityReport, Finding, Identification, JudgeVerdict, Risk } from "./types.ts";

/** Words that mark a replica, fake or "inspired by" listing. Matching ads can never be "same". */
export const REPLICA_WORDS = ["replica", "replika", "repro", "reproduction", "fake", "counterfeit", "copy of", "inspired by", "style of", "look alike", "lookalike", "homage", "kopia"] as const;
const RISK_ORDER: readonly Risk[] = ["low", "unknown", "medium", "high"] as unknown as readonly Risk[];

export interface Disagreement {
  rule: string;
  /** Ad id, or null for an item-level rule. */
  adId: number | null;
  detail: string;
}

export interface Adjudicated {
  ads: AdLabel[];
  risk: Risk;
  disagreements: Disagreement[];
  /** Ad ids whose label was changed by a rule and are worth one targeted second look (spec 1.4 item 4). */
  contested: number[];
}

const NEXT_DOWN: Record<AdMatch, AdMatch> = { same: "similar", similar: "different", different: "different" } as Record<AdMatch, AdMatch>;

/** One notch up on the risk scale (low -> medium -> high). "unknown" counts as sitting between low and medium. */
export function riskUp(r: Risk): Risk {
  if (r === "high") return "high";
  if (r === "medium") return "high";
  return "medium"; // low or unknown
}

export function higherRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

function hasReplicaWord(f: Finding): string | null {
  const t = `${f.title} ${f.snippet}`.toLowerCase();
  for (const w of REPLICA_WORDS) if (t.includes(w)) return w;
  return null;
}

function tokens(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter((x) => x.length >= 3);
}

/**
 * @param anchorUsd optional independent anchor (Judge-A) used for the price-sanity rule. When null that rule is skipped.
 */
export function adjudicate(verdict: JudgeVerdict, findings: Finding[], ident: Identification | null, auth: AuthenticityReport | null, anchorUsd: number | null = null): Adjudicated {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const out: AdLabel[] = [];
  const disagreements: Disagreement[] = [];
  const contested = new Set<number>();
  const brand = ident?.brand ? tokens(ident.brand) : [];

  for (const label of verdict.ads ?? []) {
    const f = byId.get(label.id);
    let match = label.match;
    const note = (rule: string, detail: string) => {
      disagreements.push({ rule, adId: label.id, detail });
      contested.add(label.id);
    };
    if (f) {
      // R1: replica words -> force "different".
      const w = hasReplicaWord(f);
      if (w && match !== "different") {
        match = "different";
        note("replica_words", `ad ${label.id} contains "${w}"`);
      }
      // R2: labelled "same" but the title lacks the brand token -> demote one band.
      if (match === "same" && brand.length > 0) {
        const t = new Set(tokens(`${f.title} ${f.snippet}`));
        if (!brand.some((b) => t.has(b))) {
          match = NEXT_DOWN[match];
          note("brand_missing", `ad ${label.id} labelled same but lacks the brand`);
        }
      }
      // R3: labelled "same" but priced above 4x or below 0.25x the independent anchor -> demote one band.
      if (match === "same" && anchorUsd && anchorUsd > 0 && f.priceUsd > 0) {
        const ratio = f.priceUsd / anchorUsd;
        if (ratio > 4 || ratio < 0.25) {
          match = NEXT_DOWN[match];
          note("price_vs_anchor", `ad ${label.id} costs ${ratio.toFixed(2)}x the anchor`);
        }
      }
    }
    out.push({ ...label, match });
  }

  // Item-level rules.
  let risk: Risk = verdict.authenticity_risk;
  if (auth && higherRisk(auth.risk_hint, risk) !== risk) {
    // R4: the Authenticity eye saw more risk than the Judge: take the higher, record the disagreement.
    disagreements.push({ rule: "eye_risk_higher", adId: null, detail: `eye ${auth.risk_hint} > judge ${risk}` });
    risk = auth.risk_hint;
  }
  const mism = verdict.eye_text_mismatch ?? [];
  if (mism.length > 0) {
    // R5: confirmed text mismatch -> risk up one notch.
    risk = riskUp(risk);
    disagreements.push({ rule: "eye_text_mismatch", adId: null, detail: `${mism.length} mismatch(es)` });
  }
  return { ads: out, risk, disagreements, contested: [...contested].sort((a, b) => a - b) };
}
