/*
# Interval calibration

## Purpose
- `l_calibration` holds, per bucket, the multiplier `k` that makes the 80 percent range really
  contain the selling price 8 times out of 10. The nightly `calibrate` function writes it; the
  value-item function reads it at the start of a request (cached 10 minutes).
- bucket key: `category|strength|basis` since country adaptation part 3 (older rows: `category|strength`). Parent chain:
  `category|strength`, then `strength`, then `global`. A missing bucket means k = 1.

## Security
- RLS on, no policies: only the service role can read or write. The browser (anon) cannot.
*/

CREATE TABLE IF NOT EXISTS l_calibration (
  bucket text PRIMARY KEY,
  k numeric NOT NULL CHECK (k >= 0.6 AND k <= 2.5),
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  coverage numeric CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE l_calibration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_calibration FROM anon, authenticated;
GRANT ALL ON l_calibration TO service_role;
