/*
# Calibration history and Judge band fit

## Purpose
- `l_calibration_history`: one row per bucket per night (k, n, coverage) so drift and oscillation are visible and the drift guard can read the last k values.
- `l_ad_calibration`: rows written by the nightly fit of the Judge bands (p_same se2, relative_value factors). Read at runtime (cached) and applied through applyAdCalibration (bounded).

## Security
- RLS on, no policies: service role only.
*/
CREATE TABLE IF NOT EXISTS l_calibration_history (
  id bigserial PRIMARY KEY,
  bucket text NOT NULL,
  k numeric NOT NULL CHECK (k >= 0.6 AND k <= 2.5),
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  coverage numeric CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS l_calibration_history_bucket_idx ON l_calibration_history (bucket, created_at DESC);
ALTER TABLE l_calibration_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_calibration_history FROM anon, authenticated;
GRANT ALL ON l_calibration_history TO service_role;
GRANT USAGE, SELECT ON SEQUENCE l_calibration_history_id_seq TO service_role;

CREATE TABLE IF NOT EXISTS l_ad_calibration (
  kind text NOT NULL CHECK (kind IN ('p_same', 'relative_factor')),
  band text NOT NULL,
  value numeric NOT NULL CHECK (value > 0),
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, band)
);
ALTER TABLE l_ad_calibration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_ad_calibration FROM anon, authenticated;
GRANT ALL ON l_ad_calibration TO service_role;
