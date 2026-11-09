/*
# Exchange rates kept in the database + the rate each answer was shown with

## Purpose
- `l_fx_rates` (one row, id = 1): the last GOOD table of units per 1 USD, saved by the value-item function whenever a live
  source answered. Read only when every live source fails (cold start), so real rates are used before the built-in table.
- `l_runs.fx_*`: the display currency and the rate (units per USD) an answer was shown with. The nightly `calibrate` function
  needs it to turn a selling price reported in ANY currency back into USD.

## Security
- RLS on, no policies: service role only.
*/

CREATE TABLE IF NOT EXISTS l_fx_rates (
  id integer PRIMARY KEY CHECK (id = 1),
  rates jsonb NOT NULL,
  as_of timestamptz,
  saved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE l_fx_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_fx_rates FROM anon, authenticated;
GRANT ALL ON l_fx_rates TO service_role;

ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS fx_currency text;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS fx_rate_used numeric CHECK (fx_rate_used IS NULL OR fx_rate_used > 0);
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS fx_as_of timestamptz;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS fx_source text;
