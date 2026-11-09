-- Counted valuations this calendar month and today (Europe/Stockholm) for one device hash.
-- Building block for server-side plan limits (see supabase/functions/value-item/plan-limits.ts). Service role only.
CREATE OR REPLACE FUNCTION l_plan_usage(p_user text)
RETURNS TABLE (used_month integer, used_day integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm')::integer,
    count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm')::integer
  FROM l_usage
  WHERE user_hash = p_user AND counted;
$$;

REVOKE ALL ON FUNCTION l_plan_usage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION l_plan_usage(text) TO service_role;
