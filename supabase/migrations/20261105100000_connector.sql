/*
# Connector AI: its own log and its learned dials

## Purpose
- `l_connector_log`: one row per valuation. It holds what the Connector proposed,
  what really ran (applied / control), the random draw that decided it, and per search what that search found
  (kept sold prices, discarded hits). It is self-contained, so no join with l_search_log is needed.
  `run_id` points to l_runs when the valuation was saved (no foreign key on purpose: both rows are written after the
  answer, in no fixed order, and a missing parent must never make this write fail).
- `l_connector_policy`: the learned dial (0..1) per bucket (country|category|source and parents), written nightly by the
  `connector-learn` function and read by `value-item` (cached 10 minutes). No row = nothing learned = dial 1.

## Security
- RLS on, no policies: only the service role can read or write. The browser (anon) cannot.
- Item fingerprints only: no photos, no user ids, no IP addresses.
*/

CREATE TABLE IF NOT EXISTS l_connector_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid,
  brain_version text,
  mode text NOT NULL CHECK (mode IN ('shadow', 'on')),
  applied boolean NOT NULL DEFAULT false,      -- the plan that ran was changed
  control boolean NOT NULL DEFAULT false,      -- mode on, a change was possible, and the plan was left unmodified
  held_back boolean NOT NULL DEFAULT false,    -- part of the control because the learned dial lowered the share
  draw numeric NOT NULL,                       -- the random number (0..1) that decided it
  share numeric NOT NULL,                      -- CONNECTOR_SHARE at that moment
  effective_share numeric NOT NULL,            -- share after the learned dial
  dial numeric,
  bucket text NOT NULL,
  source text NOT NULL,                        -- 'search_ai' | 'fixed'
  strategy_version integer,
  fingerprint jsonb NOT NULL,
  haiku_query text,
  local_name text,
  proposed_changes integer NOT NULL DEFAULT 0, -- how many searches rule R1 would change
  searches jsonb NOT NULL DEFAULT '[]'::jsonb, -- per search: queries, rule, and what it found
  judge_ok boolean NOT NULL DEFAULT false,
  reward numeric
);

CREATE INDEX IF NOT EXISTS l_connector_log_time_idx ON l_connector_log (created_at DESC);
CREATE INDEX IF NOT EXISTS l_connector_log_bucket_idx ON l_connector_log (bucket, created_at DESC);
CREATE INDEX IF NOT EXISTS l_connector_log_run_idx ON l_connector_log (run_id) WHERE run_id IS NOT NULL;

ALTER TABLE l_connector_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_connector_log FROM anon, authenticated;
GRANT ALL ON l_connector_log TO service_role;

CREATE TABLE IF NOT EXISTS l_connector_policy (
  bucket text PRIMARY KEY,
  dial numeric NOT NULL CHECK (dial >= 0 AND dial <= 1),
  n_treated integer NOT NULL DEFAULT 0 CHECK (n_treated >= 0),
  n_control integer NOT NULL DEFAULT 0 CHECK (n_control >= 0),
  lift numeric,
  z numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE l_connector_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_connector_policy FROM anon, authenticated;
GRANT ALL ON l_connector_policy TO service_role;
