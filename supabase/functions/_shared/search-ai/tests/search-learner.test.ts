// Phase 2B gate: the TypeScript learner must equal the Python learner (golden/learner.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideRollback, learn, parseTime, pyRound, rewardParts, slotify, train, usable } from "../learner.ts";
import { policyFromJson, policyToJson } from "../policy.ts";

const g = JSON.parse(readFileSync(new URL("./golden/learner.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-02T12:00:00Z");

function close(a: unknown, b: unknown, path = "$"): void {
  if (typeof a === "number" && typeof b === "number") {
    assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${path}: ${a} vs ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    assert.equal(a.length, b.length, `${path} length`);
    a.forEach((x, i) => close(x, b[i], `${path}[${i}]`));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    assert.deepEqual(Object.keys(a as object), Object.keys(b as object), `${path} keys/order`);
    for (const k of Object.keys(b as object)) close((a as any)[k], (b as any)[k], `${path}.${k}`);
  } else assert.deepEqual(a, b, path);
}

test("golden coverage", () => {
  assert.ok(g.slotify.length > 1000 && g.slotify.some((c: any) => c.out !== null) && g.slotify.some((c: any) => c.out === null));
  assert.ok(g.train.every((c: any) => c.out.templates.length > 0) && g.train.some((c: any) => Object.keys(c.out.sites).length > 0));
  const notes = new Set(g.learn.map((c: any) => c.note));
  assert.ok(notes.has("deployed") && notes.has("replay_rejected") && notes.has("not_enough_data"));
  assert.deepEqual(g.rollback.map((c: any) => c.out), [false, false, true]);
});
test("slotify equals Python", () => {
  for (const c of g.slotify) assert.equal(slotify(c.q, c.fp), c.out, JSON.stringify(c.q));
});
test("pyRound is half-even", () => {
  assert.equal(pyRound(0.03125, 4), 0.0312);
  assert.equal(pyRound(0.09375, 4), 0.0938);
  assert.equal(pyRound(2.5, 0), 2);
  assert.equal(pyRound(1.00005, 4), 1.0001 - 0.0000 === 1.0001 ? 1.0001 : 1.0);
});
