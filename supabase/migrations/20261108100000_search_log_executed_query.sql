/*
# Search log: keep the planned query AND the query that really ran

## Why
- The Connector may edit a search after the Search AI planned it. `l_search_log.query` always holds the PLAN's query.
  These two columns add what really ran and whether it differs, so the Search AI can tell its own results from results of
  an edited query.
- The Search AI learner ignores rows with connector_modified = true when it credits a template (their prices were found by
  the edit, not by the template). Rows from before this migration have the defaults and count as before.

## Performance
- Two nullable/defaulted columns, no index, no backfill: instant on any table size and no extra reads.

## Security
- Same table, same RLS: only the service role can read or write.
*/

ALTER TABLE l_search_log ADD COLUMN IF NOT EXISTS executed_query text;
ALTER TABLE l_search_log ADD COLUMN IF NOT EXISTS connector_modified boolean NOT NULL DEFAULT false;
