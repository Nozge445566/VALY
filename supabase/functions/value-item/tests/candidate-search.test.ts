import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateSearch } from "../pipeline/eye-search.ts";
import type { SearchPlan } from "../types.ts";

const plan = { searches: [{ id: "s1", query: "badrumsvåg såld", template_id: "x", kind: "fixed", gl: "se", hl: "sv" }], extraSearches: [] } as unknown as SearchPlan;

test("the visual-guess query becomes one extra search", () => {
  const s = candidateSearch(plan, ["badrumsvåg såld", "IKEA Fullriktig badrumsvåg såld"]);
  assert.equal(s?.query, "IKEA Fullriktig badrumsvåg såld");
  assert.equal(s?.template_id, "eyes_evidence");
  assert.equal(s?.reason, "visual_candidate");
});
test("no second query, or one already in the plan, adds nothing", () => {
  assert.equal(candidateSearch(plan, ["badrumsvåg såld"]), null);
  assert.equal(candidateSearch(plan, ["a b c", "Badrumsvåg Såld"]), null);
});
