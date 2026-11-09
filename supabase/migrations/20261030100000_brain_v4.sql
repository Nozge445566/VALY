/*
# Brain v4: Memory, per-user Protection, and the Search AI's learning data

## Memory ("Do we recognize the item?")
- `l_runs` is both "Saved in Supabase" (every NEW valuation) and Memory.
- `fingerprint_key` is the item's key (brand + model + country). `memory_eligible` is true only
  when the Judge answered and real listings backed the answer. Only those rows can answer a
  later request directly.
- A Memory hit is never saved again (the handler only saves new valuations).

## Protection (40 per hour, per user)
- `l_usage.user_hash`: hash of the anonymous device id the app sends. `ip_hash` stays as a
  looser safety net. Only hashes are stored.

## Search AI
- `l_search_log`: one row per search. Item fingerprints only: no photos, no user ids, no
  addresses. The nightly learner reads it.
- `l_search_policy`: versions of the Search AI's learned strategy. One version is active.
  The learner writes new versions and can roll back (drift watch).

## Security
- All three new/changed tables stay locked: RLS on, no policies, service role only.
  The browser (anon) cannot read or write them.
*/

-- ---------------------------------------------------------------- l_runs: Memory columns
ALTER TABLE l_runs ALTER COLUMN cache_key DROP NOT NULL;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS fingerprint_key text;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS fingerprint jsonb;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS memory_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS brain_version text;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS elapsed_ms integer;

CREATE INDEX IF NOT EXISTS l_runs_memory_idx
  ON l_runs (fingerprint_key, created_at DESC)
  WHERE memory_eligible;

-- ---------------------------------------------------------------- l_usage: per-user Protection
ALTER TABLE l_usage ADD COLUMN IF NOT EXISTS user_hash text;
CREATE INDEX IF NOT EXISTS l_usage_user_idx ON l_usage (user_hash, created_at DESC);

-- ---------------------------------------------------------------- l_search_log
CREATE TABLE IF NOT EXISTS l_search_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  strategy_version integer,              -- null = the fixed templates ran
  source text NOT NULL,                  -- 'search_ai' | 'fixed'
  fingerprint jsonb NOT NULL,            -- category, brand, type, model, era, country, language
  query text NOT NULL,
  template_id text NOT NULL,
  kind text NOT NULL,                    -- 'exploit' | 'experiment' | 'fixed'
  gl text NOT NULL,
  hl text NOT NULL,
  site text,
  result_count integer NOT NULL DEFAULT 0,
  sold_count integer NOT NULL DEFAULT 0, -- sold prices the code found
  kept_sold integer NOT NULL DEFAULT 0,  -- sold prices the Judge kept as 'same item'
  kept_asking integer NOT NULL DEFAULT 0,
  discarded integer NOT NULL DEFAULT 0,  -- hits the Judge threw away
  prices jsonb NOT NULL DEFAULT '[]'::jsonb,
  latency_ms integer NOT NULL DEFAULT 0,
  cost_usd numeric(8,5) NOT NULL DEFAULT 0,
  cancelled boolean NOT NULL DEFAULT false,
  stop_reason text,
  judge_ok boolean NOT NULL DEFAULT false -- false: the Judge did not answer, 'kept' is unknown
);

CREATE INDEX IF NOT EXISTS l_search_log_time_idx ON l_search_log (created_at DESC);
CREATE INDEX IF NOT EXISTS l_search_log_template_idx ON l_search_log (template_id, created_at DESC);

ALTER TABLE l_search_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_search_log FROM anon, authenticated;
GRANT ALL ON l_search_log TO service_role;

-- ---------------------------------------------------------------- l_search_policy
CREATE TABLE IF NOT EXISTS l_search_policy (
  version integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT false,
  policy jsonb NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text
);

-- Only one version may be active at a time.
CREATE UNIQUE INDEX IF NOT EXISTS l_search_policy_one_active
  ON l_search_policy (active) WHERE active;

ALTER TABLE l_search_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_search_policy FROM anon, authenticated;
GRANT ALL ON l_search_policy TO service_role;
