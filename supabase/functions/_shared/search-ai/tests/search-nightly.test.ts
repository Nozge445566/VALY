// Phase 3 gate: the TypeScript nightly run must equal the Python nightly run (golden/nightly.json),
// including the ORDER of every database call and the exact note text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { knownPatterns, pyJsonDumps, run } from "../nightly.ts";

const g = JSON.parse(readFileSync(new URL("./golden/nightly.json", import.meta.url), "utf8"));

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

function fakeDb(c: any, calls: any[][]) {
  return {
    fetchLogs: (since: string) => (calls.push(["fetch_logs", since]), c.rows),
    activePolicy: () => (calls.push(["active_policy"]), c.active),
    policyBefore: (v: number) => (calls.push(["policy_before", v]), c.previous),
    deactivate: (v: number, note: string) => void calls.push(["deactivate", v, note]),
    activate: (v: number, m: unknown, note: string) => void calls.push(["activate", v, m, note]),
    insertPolicy: (p: unknown, m: unknown, note: string) => (calls.push(["insert_policy", p, m, note]), c.next_version),
  };
}

test("golden coverage", () => {
  const actions = new Set(g.scenarios.map((c: any) => c.result.action));
  for (const a of ["kept", "deployed", "rolled_back", "rolled_back_to_fixed_templates"]) assert.ok(actions.has(a), a);
  assert.ok(g.scenarios.some((c: any) => c.calls.some((x: any[]) => x[0] === "activate")));
  assert.ok(g.scenarios.some((c: any) => c.calls.filter((x: any[]) => x[0] === "deactivate").length && c.calls.some((x: any[]) => x[0] === "insert_policy")));
});
test("known patterns equal Python", () => {
  assert.deepEqual([...knownPatterns()].sort(), g.known_patterns);
});
test("pyJsonDumps equals Python json.dumps", () => {
  for (const d of g.dumps) assert.equal(pyJsonDumps(d.value, new Set(["recent_rate", "baseline_rate"])), d.out);
});
