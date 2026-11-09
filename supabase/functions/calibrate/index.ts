// Supabase Edge Function "calibrate": the nightly interval calibration.
// Reads the last 90 days of l_runs joined to l_feedback (what the item REALLY sold for), replays each stored interval recipe
// (steps.interval) through the same fused engine (value-item/backtest.ts), and writes one multiplier k per bucket to
// l_calibration (maths in ../_shared/calibration-fit.ts). Feedback in ANY currency is used when it matches the currency the
// answer was shown in (rate stored in l_runs.fx_rate_used); anything else is counted and skipped (no rate is guessed). No data -> writes nothing. Service role only. Deploy: supabase functions deploy calibrate
// The pure fit is unit tested; this wrapper is a thin database adapter.

import { createClient } from "npm:@supabase/supabase-js@2";
import { bucketOfStored, fitCalibration } from "../_shared/calibration-fit.ts";
import type { FitRecord } from "../_shared/calibration-fit.ts";
import { fitJudgeBands } from "../_shared/judge-fit.ts";
import type { JudgeFitRecord } from "../_shared/judge-fit.ts";

const PAGE = 1000;
const MAX_ROWS = 20000;
const WINDOW_DAYS = 90;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(500, { error: "not set up" });
  if (req.headers.get("authorization") !== `Bearer ${key}`) return json(401, { error: "service role only" });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  const records: FitRecord[] = [];
  const judgeRecords: JudgeFitRecord[] = [];
  let skippedCurrency = 0, skippedShape = 0;
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from("l_feedback")
      .select("actual_price, currency, l_runs!inner(steps, fx_currency, fx_rate_used)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return json(500, { error: error.message });
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      type RunRow = { steps?: { interval?: Record<string, unknown> }; fx_currency?: string | null; fx_rate_used?: number | string | null };
      const runRaw = r.l_runs as RunRow | RunRow[] | null;
      const run = Array.isArray(runRaw) ? runRaw[0] : runRaw;
      // Any currency: USD as is; the currency the answer was shown in -> divide by the rate stored WITH that run (never a live guess).
      const cur = String(r.currency).toUpperCase();
      const usdPer = cur === "USD" ? 1 : run?.fx_currency?.toUpperCase() === cur && Number(run?.fx_rate_used) > 0 ? 1 / Number(run!.fx_rate_used) : null;
      if (usdPer === null) { skippedCurrency++; continue; }
      const iv = run?.steps?.interval;
      const bucket = bucketOfStored(iv as { bucket?: unknown });
      const truth = Number(r.actual_price) * usdPer;
      if (!iv || !bucket || iv["v"] !== 2 || !Array.isArray(iv["comps"]) || !iv["input"] || !(truth > 0)) { skippedShape++; continue; }
      records.push({ bucket, truthUsd: truth, stored: iv as never });
      judgeRecords.push({ truthUsd: truth, comps: iv["comps"] as never });
    }
    if (!data || data.length < PAGE) break;
  }

  const { data: prev } = await db.from("l_calibration").select("bucket, k, coverage");
  const previous = new Map<string, number>((prev ?? []).map((p: { bucket: string; k: unknown }) => [p.bucket, Number(p.k)]));
  const previousCoverage = new Map<string, number>((prev ?? []).filter((p: { coverage: unknown }) => p.coverage != null).map((p: { bucket: string; coverage: unknown }) => [p.bucket, Number(p.coverage)]));
  // last 8 nights per bucket (oldest first) for the drift guard; a missing table just means no guard
  const history = new Map<string, number[]>();
  const hist = await db.from("l_calibration_history").select("bucket, k, created_at").gte("created_at", new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString()).order("created_at", { ascending: true }).limit(5000);
  for (const h of (hist.data ?? []) as Array<{ bucket: string; k: unknown }>) { const a = history.get(h.bucket) ?? []; a.push(Number(h.k)); history.set(h.bucket, a.slice(-8)); }
  const rows = fitCalibration(records, previous, 0.8, { previousCoverage, history });
  if (rows.length > 0) await db.from("l_calibration_history").insert(rows.map((r) => ({ bucket: r.bucket, k: r.k, n: r.n, coverage: r.coverage })));
  const judgeRows = fitJudgeBands(judgeRecords);
  if (judgeRows.length > 0) await db.from("l_ad_calibration").upsert(judgeRows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "kind,band" });
  if (rows.length > 0) {
    const { error } = await db.from("l_calibration").upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "bucket" });
    if (error) return json(500, { error: error.message });
  }
  return json(200, { records: records.length, skippedCurrency, skippedShape, written: rows.length, judgeBandsWritten: judgeRows.length, rows: rows.slice(0, 50) });
});
