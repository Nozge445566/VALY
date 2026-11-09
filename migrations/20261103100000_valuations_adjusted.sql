/*
# Remember whether a learned price-level shift moved the evidence behind a saved valuation

## Why
Since part 4 the interval engine can shift foreign listings toward the user's own price level
(l_price_offsets). The result already says so (`result.market.adjusted`); the app now saves it next to
the row so the history can say it too.

## Changes
- `valuations.market_adjusted` (boolean, TRUE when a learned shift was applied, NULL on old rows = unknown)

## Security
- No RLS/policy changes: same table, same policies. The column is nullable, so old rows and old app
  versions keep working. Deploy this BEFORE the new app (the app also survives it missing, see App.tsx).
*/

ALTER TABLE valuations ADD COLUMN IF NOT EXISTS market_adjusted boolean;
