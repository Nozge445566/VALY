/*
# Protection: counted valuations, attempts and repeats

## What changes
- `l_usage` keeps one row per ATTEMPT (every request that passes the check, written before any paid work).
  New column `counted`: set to true only when that attempt finished as a successful valuation that was not a repeat.
  The limits of 20 per device per hour, 500 per network address per hour and 1,500 per rolling 24 hours count
  `counted` rows. The limit of 60 per device per hour counts every row.
- `l_device_items`: which device valued which item, and when it FIRST did so. A repeat is the same device scanning the same
  item within 24 hours of that first valuation. A repeat never moves the first time, so the 24 hours are rolling.
- `l_settle_attempt(...)`: one atomic call that finds out whether a finished valuation is a repeat and, if not, marks its
  attempt as counted.

## Security
RLS enabled and no policies on the new table; only the service role (the Edge Function) can read or write it.
*/

ALTER TABLE l_usage ADD COLUMN IF NOT EXISTS counted boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS l_usage_user_counted_idx ON l_usage (user_hash, created_at DESC) WHERE counted;
CREATE INDEX IF NOT EXISTS l_usage_ip_counted_idx ON l_usage (ip_hash, created_at DESC) WHERE counted;
CREATE INDEX IF NOT EXISTS l_usage_counted_time_idx ON l_usage (created_at DESC) WHERE counted;

CREATE TABLE IF NOT EXISTS l_device_items (
  user_hash text NOT NULL,
  item_key text NOT NULL,
  first_valued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_hash, item_key)
);

CREATE INDEX IF NOT EXISTS l_device_items_time_idx ON l_device_items (first_valued_at);

ALTER TABLE l_device_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_device_items FROM anon, authenticated;
GRANT ALL ON l_device_items TO service_role;

-- Returns true when the valuation is a repeat (free), false when it counts.
-- p_item null: the item cannot be recognised again, so it always counts and nothing is remembered.
-- p_attempt null: the attempt row could not be written earlier; the repeat question is still answered.
CREATE OR REPLACE FUNCTION l_settle_attempt(p_attempt bigint, p_user text, p_item text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_first timestamptz;
  v_repeat boolean := false;
BEGIN
  IF p_item IS NOT NULL THEN
    INSERT INTO l_device_items AS d (user_hash, item_key, first_valued_at)
    VALUES (p_user, p_item, v_now)
    ON CONFLICT (user_hash, item_key) DO UPDATE
      SET first_valued_at = CASE
        WHEN d.first_valued_at <= v_now - interval '24 hours' THEN v_now  -- window over: counts like a new item
        ELSE d.first_valued_at                                           -- still inside: keep the first time
      END
    RETURNING d.first_valued_at INTO v_first;
    v_repeat := v_first < v_now;
  END IF;

  IF NOT v_repeat AND p_attempt IS NOT NULL THEN
    UPDATE l_usage SET counted = true WHERE id = p_attempt;
  END IF;
  RETURN v_repeat;
END;
$$;

REVOKE ALL ON FUNCTION l_settle_attempt(bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION l_settle_attempt(bigint, text, text) TO service_role;
