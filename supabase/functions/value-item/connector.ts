// The Connector AI inside Market Live.
//
// WHAT IT IS. Market Live runs up to four searches: three from the fixed templates (or the Search AI) and one
// from Haiku (the item's name in the local language). The Connector links all four. The link to Haiku's search is
// the thick one: the item-specific words (the local name) flow from it into the other searches. Small, bounded
// calibration signals go out; they fine-tune a plan and never rebuild it.
//
// TWO SPEEDS.
//   Fast part  = this file. A plain synchronous function: no network, no database, no waiting, microseconds.
//   Deeper system = a small learned table (l_connector_policy, written by the nightly `connector-learn` function,
//                   maths in ../_shared/connector-learn.ts). It arrives here as `dial` (0..1) for a bucket.
//
// HARD RULES. They are enforced in code AND checked again after every change:
//   - never add or remove a search; never change id, kind, template_id, gl or hl
//   - never touch site: operators, quote marks or the sold word
//   - query length 3..120 characters, no duplicate queries
//   - Haiku's own search is edited ONLY by rule RH, which may remove a repeated word and nothing else (the product rule's
//     decision of 1 Nov 2026: the Connector calibrates all four searches). Every distinct word must survive.
//   - on any error or doubt the ORIGINAL plan comes back untouched
//
// ALL FOUR SEARCHES (1 Nov 2026). Each kind of search has its own rule and its own learned dial:
//   R1 = the local template searches (local-name transfer, below)
//   RG = the global template searches (English, gl=us): remove a repeated word
//   RH = Haiku's own search (the thick line): remove a repeated word, never a distinct one, never the local name
// Each rule gets its OWN random draw, so each is compared with its own control group by the nightly learner. The
// Connector is always on and all three rules act.
// The other direction (the thick line INTO the Connector) is the learned Haiku weight: see _shared/connector-learn.ts.
//
// RULE R1: local-name transfer. For an item WITHOUT a model the templates write the item
// as "brand + English type". In searches aimed at the user's own country, the English type is replaced by the local
// name taken from Haiku's query. It will often not fire. That is fine: it is an untested hypothesis, and the
// log and the control group exist to measure it.

export { CONNECTOR_RULE_IDS } from "../_shared/connector-learn.ts";
export type { ConnectorRuleId } from "../_shared/connector-learn.ts";
export * from "./connector/model.ts";
export * from "./connector/buckets.ts";
export * from "./connector/r1.ts";
export * from "./connector/invariants.ts";
export * from "./connector/tidy.ts";
export * from "./connector/apply.ts";
