/*
# Index for the neighbour prior
- The prior looks up kept runs by category and brand inside l_runs.fingerprint (jsonb). A partial expression index keeps that fast.
*/
CREATE INDEX IF NOT EXISTS l_runs_neighbour_idx
  ON l_runs ((fingerprint->>'category'), (fingerprint->>'brand'), created_at DESC)
  WHERE memory_eligible = true;
