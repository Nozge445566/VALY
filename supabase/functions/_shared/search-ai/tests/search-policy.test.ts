// Phase 1B: policy round trip and Python-faithful cleaning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countryStat, observations, policyFromJson, policyToJson } from "../policy.ts";

const raw = {
  schema: 1,
  arms: { g: { t1: [1.5, 20, 12.9], t2: [0, 5, 3] }, "c|x": { t1: [2, 3, 4] } },
  templates: [{ id: "a", pattern: "{brand} sold" }],
  prior: { rate: 0.5, strength: 8 },
  training: { country_stats: { SE: { sold_per_search: 1.25, n: 9 } } },
  sites: { se: [{ site: "tradera.com", gl: "se", kept: 41.2, n: 63 }] },
};

test("round trip keeps every key and value", () => {
  const p = policyFromJson(3, raw);
  assert.deepEqual(policyToJson(p), { ...raw, sites: { SE: raw.sites.se } });
  assert.equal(p.version, 3);
});
test("wrong schema or non-object gives empty policy version 0", () => {
  for (const bad of [null, 5, [], { schema: 2 }, "x"]) assert.equal(policyFromJson(9, bad).version, 0);
});
test("bad arms and templates are dropped", () => {
  const p = policyFromJson(1, { schema: 1, arms: { g: { a: [1, 2], b: [1, 2, "x"], c: [1, 2, 3] }, h: 5 }, templates: [{ id: 1 }, { id: 2, pattern: "p" }] });
  assert.deepEqual([...(p.arms.get("g")?.keys() ?? [])], ["c"]);
  assert.equal(p.templates.length, 1);
});
test("observations truncates the global sum", () => {
  assert.equal(observations(policyFromJson(1, raw)), 15);
});
test("countryStat", () => {
  const p = policyFromJson(1, raw);
  assert.deepEqual(countryStat(p, "se"), [1.25, 9]);
  assert.equal(countryStat(p, "NO"), null);
  assert.equal(countryStat(policyFromJson(1, { schema: 1, training: { country_stats: { SE: { n: 1 } } } }), "SE"), null);
});
