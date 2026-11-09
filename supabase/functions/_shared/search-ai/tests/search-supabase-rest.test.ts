// Phase 3: SupabaseRest must send the same requests as supabase_rest.py (fake fetch, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SupabaseError, SupabaseRest, type FetchLike } from "../supabase-rest.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fake(replies: Array<{ status?: number; body?: unknown; raw?: string; throws?: string }>): { f: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = replies[i++];
    if (r.throws) throw new Error(r.throws);
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (r.raw !== undefined ? r.raw : r.body === undefined ? "" : JSON.stringify(r.body)) };
  };
  return { f, calls };
}
const mk = (f: FetchLike) => new SupabaseRest("https://x.supabase.co//", "KEY", f);

test("headers, base url, active policy", async () => {
  const { f, calls } = fake([{ body: [{ version: 3 }] }, { body: [] }]);
  const db = mk(f);
  assert.deepEqual(await db.activePolicy(), { version: 3 });
  assert.equal(calls[0].url, "https://x.supabase.co/rest/v1/l_search_policy?active=is.true&limit=1");
  assert.equal(calls[0].headers.apikey, "KEY");
  assert.equal(calls[0].headers.Authorization, "Bearer KEY");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(await db.activePolicy(), null);
});
test("policyBefore, deactivate, activate, insert", async () => {
  const { f, calls } = fake([{ body: [{ version: 2 }] }, {}, {}, { body: [{ version: "9" }] }]);
  const db = mk(f);
  assert.deepEqual(await db.policyBefore(5), { version: 2 });
  assert.equal(calls[0].url.endsWith("/l_search_policy?version=lt.5&order=version.desc&limit=1"), true);
  await db.deactivate(5, "n");
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].url.endsWith("/l_search_policy?version=eq.5"), true);
  assert.deepEqual(JSON.parse(calls[1].body!), { active: false, note: "n" });
  await db.activate(4, { a: 1 }, "m");
  assert.deepEqual(JSON.parse(calls[2].body!), { active: true, metrics: { a: 1 }, note: "m" });
  assert.equal(await db.insertPolicy({ p: 1 }, { m: 2 }, "z"), 9);
  assert.equal(calls[3].method, "POST");
  assert.equal(calls[3].headers.Prefer, "return=representation");
  assert.deepEqual(JSON.parse(calls[3].body!), { policy: { p: 1 }, metrics: { m: 2 }, note: "z", active: true });
});
test("fetchLogs pages by 1000 and stops on a short page", async () => {
  const full = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const { f, calls } = fake([{ body: full }, { body: full }, { body: [{ id: 1 }] }]);
  const rows = await mk(f).fetchLogs("2026-09-03T12:00:00+00:00");
  assert.equal(rows.length, 2001);
  assert.equal(calls[0].url, "https://x.supabase.co/rest/v1/l_search_log?created_at=gte.2026-09-03T12%3A00%3A00%2B00%3A00&order=created_at.asc%2Cid.asc&limit=1000&offset=0");
  assert.ok(calls[1].url.endsWith("&limit=1000&offset=1000"));
  assert.ok(calls[2].url.endsWith("&limit=1000&offset=2000"));
});
test("fetchLogs respects maxRows", async () => {
  const full = Array.from({ length: 2 }, (_, i) => ({ id: i }));
  const { f, calls } = fake([{ body: full }, { body: full }, { body: full }]);
  const rows = await mk(f).fetchLogs("s", 2, 4);
  assert.equal(rows.length, 4);
  assert.equal(calls.length, 2);
});
test("errors keep the Python text", async () => {
  const long = "é".repeat(400);
  const { f } = fake([{ status: 500, raw: long }, { throws: "boom" }]);
  const db = mk(f);
  await assert.rejects(() => db.activePolicy(), (e: Error) => e instanceof SupabaseError && e.message === `GET /l_search_policy?active=is.true&limit=1 -> 500: ${"é".repeat(300)}`);
  await assert.rejects(() => db.activePolicy(), (e: Error) => e.message === "GET /l_search_policy?active=is.true&limit=1 failed: boom");
});
