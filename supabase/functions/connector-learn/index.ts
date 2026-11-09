// Supabase Edge Function "connector-learn": the nightly learner of the Connector's deeper system.
//
// Reads l_connector_log (the last 60 days), compares valuations where the Connector was applied with the unmodified
// control group per bucket (maths in ../_shared/connector-learn.ts), and writes one dial per bucket to
// l_connector_policy. The value-item function reads that table (cached 10 minutes). It never touches the Search
// AI or l_search_policy. Only a bucket with enough data on both sides gets a row, and one night moves a dial by at most
// 0.25. A dial only goes down when a rule is shown to hurt (z below minus a bar that is corrected for the number of tests
// of the night); anything weaker moves nothing. Without any data it writes nothing.
//
// Only the service role may call it (the nightly GitHub workflow does). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided automatically. Deploy: supabase functions deploy connector-learn

import { createClient } from "npm:@supabase/supabase-js@2";
import { clampHaikuWeight, HAIKU_LINK_WEIGHT, learnHaikuWeights, learnPolicy, slimLearnSearches } from "../_shared/connector-learn.ts";
import type { LogRowForLearning } from "../_shared/connector-learn.ts";

const PAGE = 1000;
const MAX_ROWS = 20000;
const WINDOW_DAYS = 60;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(500, { error: "not set up" });
  if (req.headers.get("authorization") !== `Bearer ${key}`) return json(401, { error: "service role only" });

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  const rows: LogRowForLearning[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from("l_connector_log")
      .select("mode, applied, proposed_changes, bucket, judge_ok, reward, searches")
      .in("mode", ["shadow", "on"]) // shadow rows only feed the Haiku weight (unmodified baselines); the dials use mode on
      // no judge_ok filter: v2 rows are scored from prices; usableRow() drops legacy rows without a Judge verdict
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return json(500, { error: error.message });
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      rows.push({
        mode: String(r.mode),
        applied: r.applied === true,
        proposed_changes: Number(r.proposed_changes) || 0,
        bucket: String(r.bucket),
        judge_ok: r.judge_ok === true,
        reward: r.reward === null || r.reward === undefined ? null : Number(r.reward),
        searches: slimLearnSearches(r.searches),
      });
    }
    if (!data || data.length < PAGE) break;
  }

  const prev = await db.from("l_connector_policy").select("bucket, dial");
  if (prev.error) return json(500, { error: prev.error.message });
  const previous = new Map(((prev.data ?? []) as { bucket: string; dial: number | string }[]).map((r) => [r.bucket, Number(r.dial)]));

  // 1. The thick line INTO the Connector: the learned Haiku weight. A missing table just means "no weights yet".
  const prevW = await db.from("l_connector_weights").select("bucket, haiku_weight");
  const previousWeights = new Map<string, number>(prevW.error ? [] : ((prevW.data ?? []) as { bucket: string; haiku_weight: number | string }[]).map((r) => [r.bucket, Number(r.haiku_weight)]));
  const weights = learnHaikuWeights(rows, previousWeights);
  const stamp = new Date().toISOString();
  if (weights.length > 0 && !prevW.error) {
    const { error } = await db.from("l_connector_weights").upsert(weights.map((w) => ({ ...w, updated_at: stamp })), { onConflict: "bucket" });
    if (error) return json(500, { error: error.message });
  }
  // The dials are scored with the weights as they are AFTER tonight's update, one common weight per bucket.
  const current = new Map(previousWeights);
  for (const w of weights) current.set(w.bucket, w.haiku_weight);
  const haikuWeightOf = (bucket: string) => {
    for (let n = bucket.split("|").length; n >= 1; n--) {
      const w = current.get(bucket.split("|").slice(0, n).join("|"));
      if (w !== undefined && Number.isFinite(w)) return clampHaikuWeight(w);
    }
    return HAIKU_LINK_WEIGHT;
  };

  // 2. The calibration OUT to all four searches: one dial per rule and bucket (R1 local, RG global, RH Haiku).
  const table = learnPolicy(rows, previous, haikuWeightOf);
  if (table.length > 0) {
    const { error } = await db.from("l_connector_policy").upsert(table.map((r) => ({ ...r, updated_at: stamp })), { onConflict: "bucket" });
    if (error) return json(500, { error: error.message });
  }
  return json(200, { ok: true, rowsRead: rows.length, buckets: table.length, table, haikuWeights: weights.length, weights });
});
