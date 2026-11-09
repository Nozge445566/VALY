// Opens the Stripe customer portal (change/cancel/receipts). SKELETON: needs secrets, not deployed or tested.
// Secrets: STRIPE_SECRET_KEY, APP_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY. POST (no body) with the user's JWT -> { url }.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: u } = await user.auth.getUser();
  if (!u.user) return json({ error: "unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await admin.from("subscriptions").select("stripe_customer_id").eq("user_id", u.user.id).maybeSingle();
  if (!row?.stripe_customer_id) return json({ error: "no_customer" }, 404);

  const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ customer: row.stripe_customer_id, return_url: `${Deno.env.get("APP_URL")}/` }),
  });
  const s = await r.json();
  return r.ok ? json({ url: s.url }) : json({ error: "stripe", detail: s?.error?.message }, 502);
});
