/*
# Remember which market a saved valuation was made for

## Why
A price made for a Swedish user (SEK, Swedish listings) must never be read as a German price later.
The Brain already sends `result.market` and `result.currency`; the app now saves them next to the row
so the history can show them.

## Changes
- `valuations.market_country` (text, ISO alpha-2, "ZZ" or NULL when unknown)
- `valuations.market_basis`   (text: local / regional / global / none, or NULL)
- `valuations.currency`       (text, ISO 4217; NULL on old rows = "show in the device's currency", as before)

## Security
- No RLS/policy changes: same table, same policies. Columns are nullable, so old rows and old app
  versions keep working. Deploy this BEFORE the new app (the app also survives it missing, see App.tsx).
*/

ALTER TABLE valuations ADD COLUMN IF NOT EXISTS market_country text;
ALTER TABLE valuations ADD COLUMN IF NOT EXISTS market_basis text;
ALTER TABLE valuations ADD COLUMN IF NOT EXISTS currency text;
