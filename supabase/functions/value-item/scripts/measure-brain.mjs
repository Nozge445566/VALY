// Measures the real speed of the deployed Brain.
//
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=... \
//     node scripts/measure-brain.mjs foto1.jpg foto2.jpg [antal-varv]
//
// Sends each photo several times (default 3 rounds) and prints the timings. Remember: the limit is
// 20 valuations per hour per device, so keep the count low. Memory answers instantly for
// the same item the second time, so the first rounds show the real Brain.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
const args = process.argv.slice(2);
const rounds = /^\d+$/.test(args.at(-1) ?? "") ? Number(args.pop()) : 3;
if (!url || !key || args.length === 0) {
  console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY and pass at least one photo.");
  process.exit(2);
}

const deviceId = randomUUID();
const times = [];
const flags = new Map();
let over7 = 0;

for (let r = 0; r < rounds; r++) {
  for (const file of args) {
    const type = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    const image = `data:${type};base64,${readFileSync(file).toString("base64")}`;
    const t0 = Date.now();
    const res = await fetch(`${url}/functions/v1/value-item`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}` },
      body: JSON.stringify({ image, currency: "USD", country: "SE", deviceId }),
    });
    const ms = Date.now() - t0;
    const body = await res.json().catch(() => ({}));
    times.push(ms);
    if (ms > 7000) over7++;
    for (const d of body?.result?.degraded ?? []) flags.set(d, (flags.get(d) ?? 0) + 1);
    console.log(`${file}  ${res.status}  ${ms} ms  ${body?.cached ? "MEMORY" : "brain "}  confidence ${body?.result?.confidenceScore ?? "-"}  ${(body?.result?.degraded ?? []).join(",")}`);
  }
}

const s = [...times].sort((a, b) => a - b);
const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
console.log(`\n${s.length} valuations: median ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${s.at(-1)} ms, over 7 s: ${over7}`);
if (flags.size) console.log("Fallbacks:", [...flags].map(([k, v]) => `${k} x${v}`).join(", "));
console.log("\nTime per step for the latest valuations (run in Supabase SQL):\n  select created_at, elapsed_ms, steps->'timing' as timing from l_runs order by created_at desc limit 20;");
