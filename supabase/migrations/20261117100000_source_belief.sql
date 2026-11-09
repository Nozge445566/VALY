/*
  # Search AI learns how far each ad source can be trusted (l_source_belief)

  The statistical ad selector (value-item/select-ads.ts) reports, per source, how many of its ads were inliers
  (sum of posterior r_i). Search AI keeps that as Beta EVIDENCE per (site, kind); the selector's prior is
  default + evidence (see _shared/search-ai/beliefs.ts). Increments are commutative and applied atomically here, so
  many Edge instances can write at once. Locked: RLS on, service role only.
*/
CREATE TABLE IF NOT EXISTS l_source_belief (
  site text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sold', 'asking')),
  alpha double precision NOT NULL DEFAULT 0 CHECK (alpha >= 0),
  beta double precision NOT NULL DEFAULT 0 CHECK (beta >= 0),
  n_updates bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, kind)
);
ALTER TABLE l_source_belief ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON l_source_belief FROM anon, authenticated;
GRANT ALL ON l_source_belief TO service_role;

CREATE OR REPLACE FUNCTION l_source_belief_add(
  p_site text, p_kind text, p_d_alpha double precision, p_d_beta double precision,
  p_forget double precision DEFAULT 0.995, p_max_weight double precision DEFAULT 400
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  a double precision; b double precision; s double precision;
BEGIN
  IF p_kind NOT IN ('sold', 'asking') OR p_site IS NULL OR p_site = '' THEN RETURN; END IF;
  p_d_alpha := GREATEST(0, LEAST(p_d_alpha, 50));
  p_d_beta := GREATEST(0, LEAST(p_d_beta, 50));
  p_forget := GREATEST(0.9, LEAST(p_forget, 1));
  INSERT INTO l_source_belief (site, kind, alpha, beta, n_updates)
  VALUES (lower(p_site), p_kind, p_d_alpha, p_d_beta, 1)
  ON CONFLICT (site, kind) DO UPDATE
    SET alpha = l_source_belief.alpha * p_forget + p_d_alpha,
        beta = l_source_belief.beta * p_forget + p_d_beta,
        n_updates = l_source_belief.n_updates + 1,
        updated_at = now()
  RETURNING l_source_belief.alpha, l_source_belief.beta INTO a, b;
  IF a + b > p_max_weight THEN
    s := p_max_weight / (a + b);
    UPDATE l_source_belief SET alpha = a * s, beta = b * s WHERE site = lower(p_site) AND kind = p_kind;
  END IF;
END $$;
REVOKE ALL ON FUNCTION l_source_belief_add FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION l_source_belief_add TO service_role;
