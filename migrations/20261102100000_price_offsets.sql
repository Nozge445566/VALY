/*
# Learned price level and foreign noise per country pair

## Purpose
- A listing from another country can sit at another price LEVEL (a US eBay price for a Swedish
  user), not only be noisier. `l_price_offsets` holds, per pair (origin -> user country), the shift
  in ln price (`offset_ln`) and the extra noise (`extra_std`) measured from REAL sales (l_feedback)
  by the nightly `calibrate` function. The value-item function reads it at the start of a request
  (cached 10 minutes) and moves foreign comparables before the interval maths.
- `offset_ln` is null until the pair has 30 real sales, `extra_std` until it has 20. A pair with no
  row means no shift and the guessed FOREIGN_STD. See supabase/functions/_shared/offsets.ts.
- `baseline_ln` is the local baseline that was subtracted, kept so a human can audit the number.

## Security
- RLS on, no policies: only the service role can read or write. The browser (anon) cannot.
*/

CREATE TABLE IF NOT EXISTS l_price_offsets (
  origin text NOT NULL CHECK (origin ~ '^[A-Z]{2}$'),
  user_country text NOT NULL CHECK (user_country ~ '^[A-Z]{2}$' AND user_country <> 'ZZ'),
  offset_ln numeric CHECK (offset_ln IS NULL OR (offset_ln >= -0.25 AND offset_ln <= 0.25)),
  extra_std numeric CHECK (extra_std IS NULL OR (extra_std >= 0 AND extra_std <= 0.5)),
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  baseline_ln numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin, user_country),
  CHECK (origin <> user_country)
);

ALTER TABLE l_price_offsets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_price_offsets FROM anon, authenticated;
GRANT ALL ON l_price_offsets TO service_role;
