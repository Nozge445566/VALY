/*
  # Country adaptation, part 1: the tier of every search

  Market Live now searches in a ladder: the user's country (local), then neighbouring markets
  (regional), then the rest of the world (global). Each logged search records its tier, so the
  nightly learner (part 2) can see which country needs which tier.

  - `l_search_log.tier`: 'local' | 'regional' | 'global' (null on rows from before this change).
  - An index on the country inside the fingerprint, for the learner's per-country queries.

  Memory needs no new column: `l_runs.fingerprint_key` already contains the country
  (m1|brand|model|COUNTRY), and the saved result now carries `result.market.country` and
  `result.market.basis` as a second lock (see memory.ts).

  Security: unchanged. RLS stays on and only the service role can read or write.
*/

ALTER TABLE l_search_log ADD COLUMN IF NOT EXISTS tier text
  CHECK (tier IS NULL OR tier IN ('local', 'regional', 'global'));

CREATE INDEX IF NOT EXISTS l_search_log_country_idx
  ON l_search_log ((fingerprint ->> 'country'), tier, created_at DESC);
