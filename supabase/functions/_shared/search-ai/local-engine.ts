// the CALL-SITE edge. Only here Math.random / Date.now / fetch / env are touched.
// Used by search-ai.ts:   const out = await localPlan(fingerprint, queries). `out` is the plan JSON. It never throws.

import { SupabaseRest } from "./supabase-rest.ts";
import { PolicyHolder, DEFAULT_REFRESH_SECONDS } from "./service.ts";
import { plan } from "./planner.ts";

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
