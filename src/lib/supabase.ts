import { createClient } from "@supabase/supabase-js";
import { TEXTS } from "./texts.ts";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Every visitor gets a private, persistent identity (an anonymous Supabase user), kept in the browser. Saved
// valuations and their photos belong to that identity: the database only returns rows where user_id = auth.uid()
// (migration 20261104100000_valuations_owner_rls.sql). No sign-up, no email.
// Without the two VITE_ variables (a deploy that forgot them) createClient would throw while the page loads and leave a white
// screen. A placeholder keeps the app up: every call then fails with the normal error banner, and valuation.ts says "not connected".
export const supabase = createClient(url || "http://127.0.0.1:54321", anonKey || "missing-anon-key", {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "valy.auth" },
});

let session: Promise<string> | null = null;

/** The current user's id. Restores the saved session, or creates an anonymous one on first visit. Safe to call often. */
export function ensureSession(): Promise<string> {
  session ??= (async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) return data.session.user.id;
    const { data: created, error } = await supabase.auth.signInAnonymously();
    if (error || !created.user) throw new Error(TEXTS.errors.session);
    return created.user.id;
  })().catch((e) => {
    session = null; // let the next call try again
    throw e instanceof Error ? e : new Error(TEXTS.errors.session);
  });
  return session;
}

export interface ValuationRow {
  id: string;
  /** Owner (auth.uid()). Set by the database. Null only on rows saved before per-user privacy; nobody can read those. */
  user_id?: string | null;
  image_data_url: string | null;
  item_name: string;
  category: string;
  brand: string;
  model: string | null;
  condition: string;
  cleanliness: string;
  estimated_value_low: number;
  estimated_value_mid: number;
  estimated_value_high: number;
  asking_price: number | null;
  notes: string | null;
  created_at: string;
  /** Market the valuation was made for (ISO alpha-2), its evidence basis and currency. Null on rows saved before country adaptation. */
  market_country?: string | null;
  market_basis?: string | null;
  /** TRUE when a learned price-level shift was applied (null on rows saved before part 4). */
  market_adjusted?: boolean | null;
  currency?: string | null;
}
