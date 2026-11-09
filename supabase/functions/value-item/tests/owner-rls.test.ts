// Guards the privacy of saved valuations: the migration must close the public policies and open owner-only ones,
// and the app must filter by the signed-in user. A regression here leaks people's photos.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../../..", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const sql = read("supabase/migrations/20261104100000_valuations_owner_rls.sql").replace(/\/\*[\s\S]*?\*\//, "");

describe("valuations are private to their owner", () => {
  it("drops every public policy and removes anon access", () => {
    for (const v of ["select", "insert", "update", "delete"]) {
      assert.match(sql, new RegExp(`DROP POLICY IF EXISTS "anon_${v}_valuations"`));
    }
    assert.match(sql, /REVOKE ALL ON valuations FROM anon/);
    assert.doesNotMatch(sql, /TO anon/i, "no policy or grant may target anon");
  });

  it("every new policy is owner-only and none is open", () => {
    assert.doesNotMatch(sql, /USING \(true\)|WITH CHECK \(true\)/i);
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    assert.equal(policies.length, 4);
    for (const p of policies) assert.match(p, /user_id = \(SELECT auth\.uid\(\)\)/);
  });

  it("the owner column is stamped by the database, so the app cannot set another user's id", () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth\.uid\(\)/);
  });

  it("the app signs in per visitor and scopes its reads and deletes to that user", () => {
    const supa = read("src/lib/supabase.ts");
    assert.match(supa, /persistSession: true/);
    assert.match(supa, /signInAnonymously\(\)/);
    const app = read("src/App.tsx");
    assert.match(app, /\.select\("\*"\)\s*\.eq\("user_id", uid\)/);
    assert.match(app, /\.delete\(\)\.eq\("user_id", uid\)/, "clear-all deletes only the user's own rows");
    assert.doesNotMatch(app, /\.neq\("id"/, "the delete-everything filter is gone");
  });
});
