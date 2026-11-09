/*
# Connector AI: Haiku weight range 2..4 -> 1.25..1.5 (fixes a CHECK limit that would reject every nightly write)

## Why
- The owner changed Haiku's weight to 1.25-1.5 (prior 1.375). The original table (migration 20261106100000) has
  CHECK (haiku_weight >= 2 AND haiku_weight <= 4), so the nightly upsert from `connector-learn` would fail as soon as it
  writes a value in the new range.
- Old rows (2..4) are already ignored by the reader (`store.ts` keeps only HAIKU_WEIGHT_MIN..MAX), so deleting them changes
  nothing in live behaviour: the prior applies until the learner rewrites them.

## Performance
- The table has one row per bucket (tiny). This migration runs once, touches no live path, adds no index and no extra read.

## Steps (order matters, safe to run more than once)
1. delete rows outside the new range (otherwise adding the new limit would fail on them)
2. drop every CHECK on this table that limits haiku_weight, found by what it checks and not by its name
3. add the new limit under a fixed name
*/

DELETE FROM l_connector_weights WHERE haiku_weight < 1.25 OR haiku_weight > 1.5;

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'l_connector_weights'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%haiku_weight%'
  LOOP
    EXECUTE format('ALTER TABLE l_connector_weights DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE l_connector_weights
  ADD CONSTRAINT l_connector_weights_haiku_weight_check CHECK (haiku_weight >= 1.25 AND haiku_weight <= 1.5);
