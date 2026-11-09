-- Plan usage per signed-in user (survives reinstall) instead of only per device hash. Rows written before this have user_id NULL.
ALTER TABLE l_usage ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE INDEX IF NOT EXISTS l_usage_user_id_created_idx ON l_usage (user_id, created_at) WHERE counted;

DROP FUNCTION IF EXISTS l_plan_usage(text);
CREATE OR REPLACE FUNCTION l_plan_usage(p_user text, p_uid uuid DEFAULT NULL)
RETURNS TABLE (used_month integer, used_day integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm')::integer,
    count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm')::integer
  FROM l_usage
  WHERE counted AND (user_hash = p_user OR (p_uid IS NOT NULL AND user_id = p_uid));
$$;
REVOKE ALL ON FUNCTION l_plan_usage(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION l_plan_usage(text, uuid) TO service_role;
