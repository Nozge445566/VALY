import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyConnector, proposeR1 } from "../connector.ts";
import { fixedPlan } from "../fixed-templates.ts";
import { COUNTRY_LANGUAGE, languageOf } from "../markets.ts";
import { REGION_GROUPS, escalationSearches } from "../market-tiers.ts";
import type { Fingerprint, SearchPlan } from "../types.ts";

// STAGE E1 (Document 2, "Stage E"): extend the Connector to Market Live's own added searches?
// FINDING (proved below for every known country): NO. Regional escalation searches always aim at a NEIGHBOUR
// (regionalPeers never contains the user's own country), and global ones are English with gl "us". R1 only
// touches searches whose gl equals the user's country and whose market language is not English, so there is
// nothing for it to rewrite. E1 therefore has no effect BY DESIGN, and these tests keep it that way:
// if escalationSearches ever starts aiming at the user's own country, the guard test fails and a human must decide.

const COUNTRIES = [...new Set<string>([...REGION_GROUPS.flat(), ...Object.keys(COUNTRY_LANGUAGE)])].sort();

const fpOf = (country: string, model: string | null): Fingerprint => ({
  category: "antiques", brand: "orrefors", type: "vase", model, era: null, country, language: languageOf(country).split("-")[0],
});

/** The escalation searches Market Live could add for this fingerprint (both tiers at once = the widest case). */
const escalationFor = (fp: Fingerprint) => escalationSearches(fp, ["regional", "global"], new Set(), 5);

describe("Connector E1: escalation searches are never rewritten", () => {
  it("covers a sensible number of countries", () => {
    assert.ok(COUNTRIES.length >= 40, `only ${COUNTRIES.length} countries checked`);
  });

  it("guard: no escalation search is aimed at the user's own country in the user's own non-English language", () => {
    for (const country of COUNTRIES) {
      for (const model of [null, "x1"]) {
        const fp = fpOf(country, model);
        for (const s of escalationFor(fp)) {
          const ownCountry = s.gl.toUpperCase() === country;
          const ownNonEnglish = s.hl === fp.language && fp.language !== "en";
          assert.ok(!(ownCountry && ownNonEnglish), `${country}: ${s.template_id} (${s.gl}/${s.hl}) targets the user's own market`);
        }
      }
    }
  });

  it("R1 proposes no change for any escalation search, in any country, with or without a model", () => {
    for (const country of COUNTRIES) {
      for (const model of [null, "x1"]) {
        const fp = fpOf(country, model);
        const base = fixedPlan(fp, [`orrefors vas såld slutpris`]);
        const esc = escalationFor(fp);
        const asPlan: SearchPlan = { ...base, searches: esc };
        const p = proposeR1(asPlan, fp, ["orrefors vas såld slutpris"]);
        assert.equal(p.changes, 0, `${country} model=${model}: R1 changed an escalation search`);
        assert.deepEqual(p.searches.map((s) => s.query), esc.map((s) => s.query));
      }
    }
  });

  it("mode on, whole plan + escalation searches together: only the planned searches may change, never the escalation ones", () => {
    const fp = fpOf("SE", null);
    const base = fixedPlan(fp, ["orrefors vas såld slutpris"]);
    // Exactly as market-live.ts does: queries already planned are passed as "used", so nothing is searched twice.
    const used = new Set(base.searches.map((s) => s.query.toLowerCase()));
    const esc = escalationSearches(fp, ["regional", "global"], used, base.searches.length + 1);
    assert.ok(esc.length >= 1, "the test needs at least one escalation search");
    const combined: SearchPlan = { ...base, searches: [...base.searches, ...esc].slice(0, 7) };
    const out = applyConnector(combined, { fingerprint: fp, haikuQueries: ["orrefors vas såld slutpris"], mode: "on", share: 1, minShare: 0.05, draw: 0, dial: null });
    assert.equal(out.plan.searches.length, combined.searches.length);
    for (const s of esc) {
      const after = out.plan.searches.find((x) => x.id === s.id);
      if (!after) throw new Error(`${s.id} disappeared`);
      assert.equal(after.query, s.query, `${s.template_id} was rewritten`);
      assert.equal(after.tier, s.tier);
    }
    const queries = out.plan.searches.map((s) => s.query.toLowerCase());
    assert.equal(new Set(queries).size, queries.length, "no duplicates");
    for (const q of queries) assert.ok(q.length >= 3 && q.length <= 120);
  });

  it("escalation searches stay inside the hard cap of 7 searches in total", () => {
    for (const country of COUNTRIES) {
      const fp = fpOf(country, null);
      const n = fixedPlan(fp, ["x y"]).searches.length + escalationFor(fp).length;
      assert.ok(n <= 4 + 2, `${country}: ${n} searches`); // plan (max 4) + one regional + one global
    }
  });
});
