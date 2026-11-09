// the CALL-SITE edge. Only here Math.random / Date.now / fetch / env are touched.
// Used by search-ai.ts:   const out = await localPlan(fingerprint, queries). `out` is the plan JSON. It never throws.

import { SupabaseRest } from "./supabase-rest.ts";
import { PolicyHolder, DEFAULT_REFRESH_SECONDS } from "./service.ts";
import { plan } from "./planner.ts";
import { SourceBook } from "./beliefs.ts";
import type { SourceBeliefs } from "./beliefs.ts";

export type Env = (name: string) => string | undefined;
// `globalThis` is untyped here: this module runs under both Deno (edge) and Node (tests, nightly job).
const denoEnv: Env = (n) => (globalThis as any).Deno?.env.get(n) ?? (globalThis as any).process?.env?.[n];

let holder: PolicyHolder | null = null; // module-level cache (survives between requests of one instance)

export function getHolder(env: Env = denoEnv): PolicyHolder {
  if (holder) return holder;
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  const every = Number(env("POLICY_REFRESH_SECONDS") ?? DEFAULT_REFRESH_SECONDS) || DEFAULT_REFRESH_SECONDS;
  holder = new PolicyHolder(url && key ? new SupabaseRest(url, key, undefined, 3.0) : null, () => Date.now() / 1000, every, (m) => console.log(m));
  return holder;
}

export function resetHolderForTests(): void { holder = null; }

export async function localPlan(fingerprint: unknown, queries: unknown, env: Env = denoEnv): Promise<Record<string, unknown>> {
  try {
    const policy = await getHolder(env).ensureFresh();
    return plan(policy, fingerprint, queries, Math.random);
  } catch (e) {
    console.warn(`[search-ai] local plan failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, reason: "engine_error" };
  }
}

// ---- Search AI's per-source trust, shared by all requests of one instance. Reads lazily (never blocks), writes best effort.
const book = new SourceBook();
export function getSourceBook(): SourceBook { return book; }

/** The production SourceBeliefs: reads refresh in the background, record() queues and flushes. Without database keys it still learns in memory. */
export function productionSourceBeliefs(env: Env = denoEnv): SourceBeliefs {
  const url = env("SUPABASE_URL"), key = env("SUPABASE_SERVICE_ROLE_KEY");
  const db = url && key ? new SupabaseRest(url, key, undefined, 3.0) : null;
  void book.ensureFresh(db, Date.now() / 1000); // fire and forget: the selection never waits for the database
  return {
    belief: (f) => book.belief(f),
    record: (ev) => { book.record(ev); void book.flush(db); },
  };
}
