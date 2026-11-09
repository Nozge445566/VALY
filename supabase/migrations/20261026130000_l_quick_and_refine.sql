/*
# L v2: quick answer first, deeper check afterwards

- `l_runs.image_hash`: fingerprint of the photo. The deeper check only runs for the same
  photo that produced the quick answer.
- `l_runs.refined`: true once the deeper check (judge, second price opinion, live
  listings) has finished.
- `l_runs.currency` is no longer needed: results are stored in USD and converted to the
  user's currency with live exchange rates every time they are sent.
*/

ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS image_hash text;
ALTER TABLE l_runs ADD COLUMN IF NOT EXISTS refined boolean NOT NULL DEFAULT false;
ALTER TABLE l_runs ALTER COLUMN currency DROP NOT NULL;
