/*
# Add cleanliness column to valuations

## Changes
- Adds `cleanliness` (text) column to `valuations`, defaulting to 'average'.
  Stores the user's visual assessment of how clean/well-kept the item looks,
  used alongside `condition` as a separate value factor.

## Security
- No RLS/policy changes needed — the table already allows anon/authenticated CRUD.
*/

ALTER TABLE valuations
  ADD COLUMN IF NOT EXISTS cleanliness text NOT NULL DEFAULT 'average';
