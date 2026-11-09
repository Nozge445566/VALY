/*
# Search log: credit every search for the sold prices it found itself

## Why
- Market Live runs several searches at the same time. When two of them find the same listing, only the first one to answer
  keeps it for the Judge (correct for the Judge). `l_search_log.prices` is built from those kept copies, so a search that
  answered a few milliseconds later showed no prices and the Search AI learned "this template is worse" because of a race.
- `own_sold` holds the sold prices a search found ITSELF (USD, Google's order, at most 5), also the listings another search
  delivered first. The learner credits a search from this column when it is present.
- `prices` keeps its exact meaning (each listing once, first delivery). The market median is still built from `prices`.

## What is stored
- A plain JSON array of USD numbers, for example [60, 61]. Never listing links, keys or hashes.
- NULL means "not recorded": every row written before this migration, and searches that failed or were cancelled.
  The learner scores NULL rows exactly as before.

## Performance
- One nullable column, no default, no index, no backfill: instant on any table size and no extra reads.

## Security
- Same table, same RLS: only the service role can read or write.
*/

ALTER TABLE l_search_log ADD COLUMN IF NOT EXISTS own_sold jsonb;
