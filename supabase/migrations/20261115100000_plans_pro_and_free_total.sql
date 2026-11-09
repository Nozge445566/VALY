-- New plan sheet: Gratis (20 scans in total, once), Pro 99 kr, Premium 199 kr. "plus" is renamed "pro".
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
UPDATE public.subscriptions SET plan = 'pro' WHERE plan = 'plus';
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_plan_check CHECK (plan IN ('free','pro','premium'));

-- Usage now also returns the all-time total (Free is a one-time allowance).
DROP FUNCTION IF EXISTS l_plan_usage(text, uuid);
CREATE OR REPLACE FUNCTION l_plan_usage(p_user text, p_uid uuid DEFAULT NULL)
RETURNS TABLE (used_month integer, used_day integer, used_total integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm')::integer,
    count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Stockholm') AT TIME ZONE 'Europe/Stockholm')::integer,
    count(*)::integer
  FROM l_usage
  WHERE counted AND (user_hash = p_user OR (p_uid IS NOT NULL AND user_id = p_uid));
$$;
REVOKE ALL ON FUNCTION l_plan_usage(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION l_plan_usage(text, uuid) TO service_role;
