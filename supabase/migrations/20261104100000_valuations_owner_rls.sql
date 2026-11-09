/*
# Valuations belong to the person who made them

## Why
The first version of `valuations` was single-tenant: every policy was `USING (true)` for `anon`, so any visitor
could list, read, change or delete EVERY saved valuation, including the photos. This migration makes each row private
to its owner.

## How
- The app signs every visitor in anonymously (Supabase anonymous sign-ins), so each browser has a real, persistent
  user id (`auth.uid()`). No sign-up screen, no email.
- `valuations.user_id` defaults to `auth.uid()`, so the app cannot forget to set it, and cannot set someone else's.
- The four public policies are dropped. New policies allow a row only when `user_id = auth.uid()`.
- The `anon` role loses all access to the table. Only a signed-in (anonymous or not) user can touch their own rows.

## Existing rows
Rows saved before this migration have `user_id IS NULL`. Nobody can see them any more (they were public and mixed
between everyone). They are kept, not deleted. To remove them for good, run once in the SQL editor:
    DELETE FROM valuations WHERE user_id IS NULL;

## Needs (dashboard, one switch)
Authentication -> Sign In / Providers -> "Allow anonymous sign-ins" = ON. Apply this migration BEFORE shipping the app.
*/

ALTER TABLE valuations
  ADD COLUMN IF NOT EXISTS user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS valuations_user_created_idx ON valuations (user_id, created_at DESC);

ALTER TABLE valuations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_valuations" ON valuations;
DROP POLICY IF EXISTS "anon_insert_valuations" ON valuations;
DROP POLICY IF EXISTS "anon_update_valuations" ON valuations;
DROP POLICY IF EXISTS "anon_delete_valuations" ON valuations;

REVOKE ALL ON valuations FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON valuations TO authenticated;

DROP POLICY IF EXISTS "owner_select_valuations" ON valuations;
CREATE POLICY "owner_select_valuations" ON valuations FOR SELECT
  TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "owner_insert_valuations" ON valuations;
CREATE POLICY "owner_insert_valuations" ON valuations FOR INSERT
  TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "owner_update_valuations" ON valuations;
CREATE POLICY "owner_update_valuations" ON valuations FOR UPDATE
  TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "owner_delete_valuations" ON valuations;
CREATE POLICY "owner_delete_valuations" ON valuations FOR DELETE
  TO authenticated USING (user_id = (SELECT auth.uid()));
