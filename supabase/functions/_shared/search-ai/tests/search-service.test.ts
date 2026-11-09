// The Search AI policy cache (PolicyHolder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyHolder } from "../service.ts";

test("policy cache: starts empty, loads, keeps old on failure, refreshes lazily after 300 s", async () => {
  let t = 1000, calls = 0, mode: "row" | "none" | "fail" = "none";
  const logs: string[] = [];
  const db = { activePolicy: async () => { calls++; if (mode === "fail") throw new Error("boom"); return mode === "row" ? { version: 7, policy: { schema: 1 } } : null; } };
  const h = new PolicyHolder(db, () => t, 300, (m) => logs.push(m));
  assert.equal(h.get().version, 0);
  assert.equal((await h.ensureFresh()).version, 0); assert.equal(calls, 1); // first load, no row -> version 0
  mode = "row"; t += 299; await h.ensureFresh(); assert.equal(calls, 1);   // not due yet
  t += 1; assert.equal((await h.ensureFresh()).version, 7); assert.equal(calls, 2); assert.equal(h.loadedAt, t);
  mode = "fail"; t += 300; assert.equal((await h.ensureFresh()).version, 7); assert.equal(calls, 3); // KEEP old
  assert.match(logs[0], /policy refresh failed, keeping the old one: boom/);
  t += 10; await h.ensureFresh(); assert.equal(calls, 3);                    // failure also waits the interval
  assert.equal(h.get().version, 7);
});

test("no database: stays empty, never throws", async () => {
  const h = new PolicyHolder(null, () => 1);
  assert.equal((await h.ensureFresh()).version, 0);
  assert.equal(h.loadedAt, null);
});
