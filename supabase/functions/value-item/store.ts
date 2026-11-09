// Database access for the Brain (Supabase, service role). Only used from index.ts.
// The service key never leaves the Edge Function.
//
//   l_runs        Memory + "Saved in Supabase": every NEW valuation, with its item fingerprint.
//   l_usage       Protection: one row per attempt; `counted` marks the ones that were successful, non-repeat valuations.
//   l_device_items  Protection: which device first valued which item and when (for the free repeats within 24 hours).
//   l_search_log  What the nightly learner learns from (item fingerprints only).
//   l_connector_log / l_connector_policy  The Connector AI's own log and its learned dials (item fingerprints only).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { StoredValuation } from "./memory.ts";
import { MAX_NEIGHBOURS } from "./neighbour-prior.ts";
import type { NeighbourRow } from "./neighbour-prior.ts";
import { parseCountryStats } from "./market-tiers.ts";
import type { CountryStat } from "./market-tiers.ts";
import { parseOffsetRows } from "../_shared/offsets.ts";
import type { OffsetRow } from "../_shared/offsets.ts";
import { normalizePlan } from "./plan-limits.ts";
import type { PlanId } from "./plan-limits.ts";
import { REPEAT_WINDOW_MS, decideVerdict } from "./protection.ts";
import type { AttemptCheck, Limits, UsageStore } from "./protection.ts";
import { HAIKU_WEIGHT_MAX, HAIKU_WEIGHT_MIN, weightKey } from "../_shared/connector-learn.ts";
import { insertSearchLog } from "./search-log-insert.ts";
import type { BrainResult, ConnectorLogRow, Fingerprint, SearchLogRow } from "./types.ts";

export interface SaveRunInput {
  /** Made by the handler before saving, so the answer can carry it without waiting for the database. */
  id: string;
  memoryKey: string | null;
  fingerprint: Fingerprint | null;
  memoryEligible: boolean;
  imageHash: string;
  steps: Record<string, unknown>;
  result: BrainResult;
  brainVersion: string;
  elapsedMs: number;
  /** The rate the answer was shown with: units of `currency` per 1 USD. Needed to turn feedback in that currency back into USD. */
  fx?: { currency: string; rate: number | null; asOf: string | null; source: string };
}

/** What the pipeline and handler need from the database. Implemented below, faked in tests. */
export interface Store extends UsageStore {
  /**
   * Plan limits . Verifies the caller's JWT, reads `subscriptions` for that user and the counted
   * valuations this month/today for the device hash (l_plan_usage). Optional: a store without it enforces no plan limit.
   */
  planAndUsage?(userHash: string, authToken: string | null): Promise<{ plan: "free" | "pro" | "premium" | "business"; usedMonth: number; usedDay: number; usedTotal: number; userId: string | null }>;
  /**
   * The newest saved valuations of this item that were kept for reuse, newest first (at most MEMORY_ROWS_FETCHED).
   * Which one may answer is decided by memory.ts::selectStored, never here.
   */
  findMemory(key: string, maxAgeMs: number): Promise<StoredValuation[]>;
  /**
   * Past kept results of SIMILAR items (same category and brand), newest first, for the neighbour prior. The store converts each
   * result's mid price to USD with the rate saved with that run; a row it cannot convert has midUsd null. Optional.
   */
  findNeighbours?(fp: { category: string; brand: string | null; model: string | null; mode?: string }, maxAgeMs: number): Promise<NeighbourRow[]>;
  saveRun(run: SaveRunInput): Promise<string | null>;
  logSearches(rows: SearchLogRow[]): Promise<void>;
  /** The nightly calibration table (l_calibration): one width multiplier k per bucket. */
  loadCalibration(): Promise<{ bucket: string; k: number }[]>;
  /** Nightly-fitted Judge band values (l_ad_calibration). Optional: a store without it keeps the default tables. */
  loadAdCalibration?(): Promise<{ kind: "p_same" | "relative_factor"; band: string; value: number; n: number }[]>;
  /** What the nightly learner measured per country (active row of l_search_policy, training.country_stats). */
  loadCountryStats(): Promise<CountryStat[]>;
  /** Learned price level and noise per country pair (l_price_offsets). */
  loadPriceOffsets(): Promise<OffsetRow[]>;
  /** Connector: one row per valuation (l_connector_log). Written after the answer has gone out; a failure is swallowed. */
  logConnector(row: ConnectorLogRow): Promise<void>;
  /** Connector: the learned dial per bucket (l_connector_policy, written by the nightly connector-learn function). */
  loadConnectorPolicy(): Promise<{ bucket: string; dial: number }[]>;
  /** Last good exchange-rate table (l_fx_rates), so a cold start with every live source down still has real rates. Optional: fakes may omit. */
  loadFx?(): Promise<{ rates: Record<string, number>; asOf: string | null; savedAt: number } | null>;
  saveFx?(t: { rates: Record<string, number>; asOf: string | null }): Promise<void>;
}

/** How many of the newest valuations of one item Memory looks at (it compares them with each other). */
export const MEMORY_ROWS_FETCHED = 8;

export function createStore(url: string, serviceKey: string): Store {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    async findMemory(key, maxAgeMs) {
      const since = new Date(Date.now() - maxAgeMs).toISOString();
      const { data, error } = await db
        .from("l_runs")
        .select("id, result, created_at, memory_eligible, brain_version")
        .eq("fingerprint_key", key)
        .eq("memory_eligible", true)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(MEMORY_ROWS_FETCHED);
      if (error) throw new Error(error.message);
      return ((data ?? []) as { id: string; result: BrainResult; created_at: string; memory_eligible: boolean; brain_version: string | null }[]).map(
        (row) => ({
          runId: row.id,
          result: row.result,
          createdAt: row.created_at,
          memoryEligible: row.memory_eligible === true,
          brainVersion: row.brain_version,
        }),
      );
    },

    async planAndUsage(userHash: string, authToken: string | null) {
      let plan: PlanId = "free";
      let userId: string | null = null;
      if (authToken) {
        const u = await db.auth.getUser(authToken);
        const uid = u.data?.user?.id;
        if (uid) {
          userId = uid;
          const sub = await db.from("subscriptions").select("plan,status,current_period_end").eq("user_id", uid).maybeSingle();
          const row = sub.data as { plan?: unknown; status?: unknown; current_period_end?: string | null } | null;
          const expired = row?.current_period_end ? new Date(row.current_period_end).getTime() < Date.now() - 3 * 24 * 3600 * 1000 : false;
          if (row && !expired) plan = normalizePlan(row.plan, row.status);
        }
      }
      const r = await db.rpc("l_plan_usage", { p_user: userHash, p_uid: userId });
      if (r.error) throw new Error(r.error.message);
      const row = (Array.isArray(r.data) ? r.data[0] : r.data) as { used_month?: number; used_day?: number; used_total?: number } | null;
      return { plan, usedMonth: row?.used_month ?? 0, usedDay: row?.used_day ?? 0, usedTotal: row?.used_total ?? 0, userId };
    },
    async registerAttempt(userHash: string, ipHash: string, limits: Limits, userId?: string | null): Promise<AttemptCheck> {
      const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const dayAgo = new Date(Date.now() - REPEAT_WINDOW_MS).toISOString();
      const count = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> => {
        const r = await q;
        if (r.error) throw new Error(r.error.message);
        return r.count ?? 0;
      };
      const head = { count: "exact", head: true } as const;

      // The four counts are independent, so they run side by side: the check stays quick (it is inside the 7 s).
      const [userCounted, userAttempts, ipCounted, dayCounted] = await Promise.all([
        count(db.from("l_usage").select("id", head).eq("user_hash", userHash).eq("counted", true).gte("created_at", hourAgo)),
        count(db.from("l_usage").select("id", head).eq("user_hash", userHash).gte("created_at", hourAgo)),
        count(db.from("l_usage").select("id", head).eq("ip_hash", ipHash).eq("counted", true).gte("created_at", hourAgo)),
        count(db.from("l_usage").select("id", head).eq("counted", true).gte("created_at", dayAgo)),
      ]);
      const verdict = decideVerdict({ userCounted, userAttempts, ipCounted, dayCounted }, limits);
      if (verdict !== "ok") return { verdict, attemptId: null };

      // Every attempt is written now, before any paid work. It only becomes a counted valuation in settleAttempt.
      const ins = await db.from("l_usage").insert({ user_hash: userHash, ip_hash: ipHash, counted: false, ...(userId ? { user_id: userId } : {}) }).select("id").single();
      if (ins.error || !ins.data) throw new Error(ins.error?.message ?? "no usage row returned");

      // Housekeeping: now and then, remove old rows. COUNTED rows are kept: the plan limits (Free 20 in total, Pro/Premium/Business
      // per month, see l_plan_usage) are computed from them, so deleting them would reset every limit after two days.
      if (Math.random() < 0.02) {
        const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        await db.from("l_usage").delete().eq("counted", false).lt("created_at", old);
        await db.from("l_device_items").delete().lt("first_valued_at", old);
      }
      return { verdict: "ok", attemptId: Number((ins.data as { id: number | string }).id) };
    },

    async settleAttempt(attemptId, userHash, itemKey) {
      const { data, error } = await db.rpc("l_settle_attempt", { p_attempt: attemptId, p_user: userHash, p_item: itemKey });
      if (error) throw new Error(error.message);
      return { repeat: data === true };
    },

    async markCounted(attemptId) {
      const { error } = await db.from("l_usage").update({ counted: true }).eq("id", attemptId);
      if (error) throw new Error(error.message);
    },

    async findNeighbours(fp, maxAgeMs) {
      if (!fp.brand) return []; // category alone is too loose a neighbourhood
      const since = new Date(Date.now() - maxAgeMs).toISOString();
      let q = db
        .from("l_runs")
        .select("result, created_at, brain_version, fingerprint, fx_currency, fx_rate_used")
        .eq("memory_eligible", true)
        .eq("fingerprint->>category", fp.category)
        .eq("fingerprint->>brand", fp.brand)
        .gte("created_at", since);
      // Neighbours by mode: a non-resale item sees only its own mode; resale sees rows with no mode (all old rows), as before.
      q = fp.mode ? q.eq("fingerprint->>mode", fp.mode) : q.is("fingerprint->>mode", null);
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .limit(MAX_NEIGHBOURS);
      if (error) throw new Error(error.message);
      type Row = { result?: { mid?: unknown; confidenceScore?: unknown; currency?: unknown }; created_at: string; brain_version: string | null; fingerprint?: { model?: string | null }; fx_currency?: string | null; fx_rate_used?: number | string | null };
      return ((data ?? []) as Row[]).map((r) => {
        const mid = Number(r.result?.mid);
        const cur = String(r.result?.currency ?? "").toUpperCase();
        const rate = cur === "USD" ? 1 : r.fx_currency?.toUpperCase() === cur ? Number(r.fx_rate_used) : NaN;
        const conf = Number(r.result?.confidenceScore);
        return {
          midUsd: Number.isFinite(mid) && mid > 0 && Number.isFinite(rate) && rate > 0 ? mid / rate : null,
          confidence: Number.isFinite(conf) ? conf : null,
          createdAt: r.created_at,
          brainVersion: r.brain_version,
          sameModel: !!fp.model && r.fingerprint?.model === fp.model,
        };
      });
    },

    async saveRun(run) {
      const { data, error } = await db
        .from("l_runs")
        .insert({
          id: run.id,
          cache_key: run.memoryKey ?? "none",
          cacheable: run.memoryEligible,
          fingerprint_key: run.memoryKey,
          fingerprint: run.fingerprint,
          memory_eligible: run.memoryEligible,
          image_hash: run.imageHash,
          hints: {},
          steps: run.steps,
          result: run.result,
          refined: true,
          brain_version: run.brainVersion,
          elapsed_ms: Math.round(run.elapsedMs),
          ...(run.fx ? { fx_currency: run.fx.currency, fx_rate_used: run.fx.rate, fx_as_of: run.fx.asOf, fx_source: run.fx.source } : {}),
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(error?.message ?? "no row returned");
      return (data as { id: string }).id;
    },

    async loadFx() {
      const { data, error } = await db.from("l_fx_rates").select("rates, as_of, saved_at").eq("id", 1).maybeSingle();
      if (error || !data) return null;
      const d = data as { rates: Record<string, number>; as_of: string | null; saved_at: string };
      return { rates: d.rates, asOf: d.as_of, savedAt: Date.parse(d.saved_at) };
    },

    async saveFx(t) {
      const { error } = await db.from("l_fx_rates").upsert({ id: 1, rates: t.rates, as_of: t.asOf, saved_at: new Date().toISOString() }, { onConflict: "id" });
      if (error) throw new Error(error.message);
    },

    async loadCalibration() {
      const { data, error } = await db.from("l_calibration").select("bucket, k");
      if (error) throw new Error(error.message);
      return ((data ?? []) as { bucket: string; k: number | string }[])
        .map((r) => ({ bucket: r.bucket, k: Number(r.k) }))
        .filter((r) => typeof r.bucket === "string" && Number.isFinite(r.k));
    },

    async loadAdCalibration() {
      const { data, error } = await db.from("l_ad_calibration").select("kind, band, value, n");
      if (error) throw new Error(error.message);
      return ((data ?? []) as { kind: string; band: string; value: number | string; n: number | string }[])
        .map((r) => ({ kind: r.kind as "p_same" | "relative_factor", band: String(r.band), value: Number(r.value), n: Number(r.n) }))
        .filter((r) => (r.kind === "p_same" || r.kind === "relative_factor") && Number.isFinite(r.value));
    },

    async loadCountryStats() {
      const { data, error } = await db.from("l_search_policy").select("policy").eq("active", true).limit(1);
      if (error) throw new Error(error.message);
      const policy = ((data ?? [])[0] as { policy?: { training?: { country_stats?: unknown } } } | undefined)?.policy;
      return parseCountryStats(policy?.training?.country_stats);
    },

    async loadPriceOffsets() {
      const { data, error } = await db.from("l_price_offsets").select("origin, user_country, offset_ln, extra_std, n, baseline_ln");
      if (error) throw new Error(error.message);
      return parseOffsetRows(data ?? []);
    },

    async logConnector(row) {
      const { error } = await db.from("l_connector_log").insert(row);
      if (error) throw new Error(error.message);
    },

    async loadConnectorPolicy() {
      const { data, error } = await db.from("l_connector_policy").select("bucket, dial");
      if (error) throw new Error(error.message);
      const dials = ((data ?? []) as { bucket: string; dial: number | string }[])
        .map((r) => ({ bucket: r.bucket, dial: Number(r.dial) }))
        .filter((r) => typeof r.bucket === "string" && Number.isFinite(r.dial) && r.dial >= 0 && r.dial <= 1);
      // The learned Haiku weights live in their own small table and arrive in the same list under the key W@bucket. A
      // missing table or an error here must never take the dials down with it: then Haiku keeps the prior weight.
      let weights: { bucket: string; dial: number }[] = [];
      try {
        const w = await db.from("l_connector_weights").select("bucket, haiku_weight");
        if (!w.error) {
          weights = ((w.data ?? []) as { bucket: string; haiku_weight: number | string }[])
            .map((r) => ({ bucket: weightKey(r.bucket), dial: Number(r.haiku_weight) }))
            .filter((r) => Number.isFinite(r.dial) && r.dial >= HAIKU_WEIGHT_MIN && r.dial <= HAIKU_WEIGHT_MAX);
        }
      } catch {
        weights = [];
      }
      return [...dials, ...weights];
    },

    async logSearches(rows) {
      await insertSearchLog(db, rows);
    },
  };
}
