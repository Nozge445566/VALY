// Phase 1 gate: TypeScript fingerprint + data must equal the Python goldens exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanFingerprint, contextKeys, itemText, norm } from "../fingerprint.ts";
import * as data from "../data.ts";

const load = (n: string) => JSON.parse(readFileSync(new URL(`./golden/${n}`, import.meta.url), "utf8"));
const cases = load("fingerprint.json");
const g = load("data-norm.json");

test("golden has enough coverage", () => {
  assert.ok(cases.length >= 150);
  assert.ok(new Set(cases.map((c: any) => c.clean?.country).filter(Boolean)).size >= 25);
});

test("cleanFingerprint, contextKeys, itemText match Python", () => {
  for (const c of cases) {
    const got = cleanFingerprint(c.raw);
    assert.deepEqual(got, c.clean, JSON.stringify(c.raw));
    if (c.clean) {
      assert.deepEqual(contextKeys(got!), c.keys, JSON.stringify(c.raw));
      assert.equal(itemText(got!), c.text, JSON.stringify(c.raw));
    }
  }
});

test("norm matches Python", () => {
  for (const n of g.norm) assert.equal(norm(n.value, n.limit), n.out, JSON.stringify(n));
});

test("data accessors match Python", () => {
  const d = g.data;
  const nul = (k: string) => (k === "None" ? null : k);
  for (const [k, v] of Object.entries(d.language_of)) assert.equal(data.languageOf(nul(k)), v, k);
  for (const [k, v] of Object.entries(d.marketplaces)) assert.deepEqual(data.marketplaces(k), v, k);
  for (const [k, v] of Object.entries(d.region_of)) assert.equal(data.regionOf(nul(k)), v, k);
  for (const [k, v] of Object.entries(d.regional_peers)) assert.deepEqual(data.regionalPeers(nul(k)), v, k);
  for (const [k, v] of Object.entries(d.tier_of_gl)) {
    const [gl, u] = k.split("|");
    assert.equal(data.tierOfGl(gl, u), v, k);
  }
  for (const [k, v] of Object.entries(d.sold_local)) assert.equal(data.soldLocal(k), v, k);
  for (const [k, v] of Object.entries(d.sold_word)) assert.equal(data.soldWord(k), v, k);
  for (const [k, v] of Object.entries(d.specialist_for)) assert.equal(data.specialistFor(k), v, k);
  assert.deepEqual(data.regionGroups(), d.region_groups);
  assert.deepEqual(data.thresholds(), d.thresholds);
  assert.deepEqual([...data.dataRich()].sort(), d.data_rich);
});

test("accessors return copies", () => {
  data.marketplaces("SE").push("x");
  assert.ok(!data.marketplaces("SE").includes("x"));
});
