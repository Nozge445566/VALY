// Is the starting list of data-rich countries right? (Sweden was a guess.)
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/check-countries.mjs
//   node scripts/check-countries.mjs policy.json       (offline: a saved l_search_policy.policy)
//
// Compares the starting `data_rich` list with what the nightly Search AI measured (kept sold prices per LOCAL
// search, `policy.training.country_stats`). It only REPORTS. A "contradicted" row is already corrected
// inside the Brain once the country has enough searches; edit DATA_RICH in market-tiers.ts so the starting list is right too.
import { readFileSync } from "node:fs";
import { assumptionCheck, parseCountryStats, COUNTRY_STATS_MIN_N, THIN_BELOW_SOLD_PER_SEARCH } from "../supabase/functions/value-item/market-tiers.ts";

let policy;
const file = process.argv[2];
if (file) {
  policy = JSON.parse(readFileSync(file, "utf8"));
} else {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass a policy.json file.");
    process.exit(2);
  }
  const res = await fetch(`${url}/rest/v1/l_search_policy?select=policy&active=eq.true&limit=1`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`Supabase answered ${res.status}: ${await res.text()}`);
    process.exit(2);
  }
  policy = (await res.json())[0]?.policy;
}
const rows = assumptionCheck(parseCountryStats(policy?.training?.country_stats));
const fmt = (x) => (x === null ? "n/a" : x.toFixed(2));
console.log(`Thin below ${THIN_BELOW_SOLD_PER_SEARCH} kept sold prices per local search. A figure is trusted from ${COUNTRY_STATS_MIN_N} searches.\n`);
console.log("country  assumed  measured  searches  status");
for (const r of rows) console.log(`${r.country.padEnd(8)} ${r.assumed.padEnd(8)} ${fmt(r.measured).padStart(8)}  ${String(r.n).padStart(8)}  ${r.status}`);
const wrong = rows.filter((r) => r.status === "contradicted");
if (wrong.length) console.log(`\nContradicted: ${wrong.map((r) => r.country).join(", ")}. Fix the starting list (see header).`);
process.exit(wrong.length ? 1 : 0);
