/*
# Connector AI: the learned Haiku weight (the thick line INTO the Connector)

## Purpose
- `l_connector_weights`: how many times Haiku's search counts, compared with each of the other three (which count 1),
  when the Connector scores a valuation. One row per bucket (country|category|source, and the parents country|category
  and country). Written nightly by the `connector-learn` function, read by `value-item` (cached 10 minutes, together
  with the dials). No row = nothing learned = the prior (1.375).
- The learner keeps it between 1.25 and 1.5 and moves it at most 0.05 per night (see _shared/connector-learn.ts).
- NOTE: this file is the ORIGINAL table definition and its CHECK below still says 2..4. That limit is replaced by
  migration 20261107100000_connector_weights_range.sql (1.25..1.5). Do not edit the SQL below: this file may already be applied.
- The dials of the two new rules RG (global searches) and RH (Haiku's search) need NO migration: they live in the
  existing `l_connector_policy` table under the keys `RG@bucket` and `RH@bucket`.

## Security
- RLS on, no policies: only the service role can read or write. The browser (anon) cannot.
*/

CREATE TABLE IF NOT EXISTS l_connector_weights (
  bucket text PRIMARY KEY,
  haiku_weight numeric NOT NULL CHECK (haiku_weight >= 2 AND haiku_weight <= 4),
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  ratio numeric,                               -- Haiku's mean yield divided by the mean yield of the other searches
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE l_connector_weights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_connector_weights FROM anon, authenticated;
GRANT ALL ON l_connector_weights TO service_role;
