/*
# Tables for L, the valuation pipe

## Purpose
- `l_runs`: every valuation L has made (raw steps + final result). Used as a cache
  (same photo = same answer, no new cost) and as the base for learning later.
- `l_feedback`: what an item REALLY sold for, reported by the user. This is the facit
  that lets us measure and improve L.
- `l_usage`: one row per new valuation, used to limit how often one caller can trigger
  paid AI calls. Only a hash of the caller's address is stored.

## Security
- `l_runs` and `l_usage`: RLS enabled and NO policies. Only the Edge Function
  (service role) can read or write them. The browser (anon) cannot.
- `l_feedback`: the browser may only INSERT (no read, no update, no delete).
*/

CREATE TABLE IF NOT EXISTS l_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key text NOT NULL,
  cacheable boolean NOT NULL DEFAULT true,
  currency text NOT NULL,
  hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS l_runs_cache_idx ON l_runs (cache_key, created_at DESC);

ALTER TABLE l_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_runs FROM anon, authenticated;
GRANT ALL ON l_runs TO service_role;

CREATE TABLE IF NOT EXISTS l_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES l_runs(id) ON DELETE CASCADE,
  actual_price numeric(14,2) NOT NULL CHECK (actual_price > 0),
  currency text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE l_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_feedback FROM anon, authenticated;
GRANT INSERT ON l_feedback TO anon, authenticated;
GRANT ALL ON l_feedback TO service_role;

DROP POLICY IF EXISTS "anon_insert_l_feedback" ON l_feedback;
CREATE POLICY "anon_insert_l_feedback" ON l_feedback FOR INSERT
  TO anon, authenticated WITH CHECK (true);

CREATE TABLE IF NOT EXISTS l_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS l_usage_ip_idx ON l_usage (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS l_usage_time_idx ON l_usage (created_at DESC);

ALTER TABLE l_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_usage FROM anon, authenticated;
GRANT ALL ON l_usage TO service_role;
