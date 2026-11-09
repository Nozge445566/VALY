// Entry for the scheduled nightly job:   node --experimental-strip-types supabase/functions/_shared/search-ai/nightly-entry.ts
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Exit code 2 if one is missing.
import { SupabaseRest } from "./supabase-rest.ts";
import { run } from "./nightly.ts";

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(2);
}
const result = await run(new SupabaseRest(url, key), new Date());
console.log(JSON.stringify(result));
