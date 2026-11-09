// Starts a Stripe Checkout for Pro/Premium. SKELETON: needs secrets, not deployed or tested.
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_PRO_MONTH, STRIPE_PRICE_PRO_YEAR, STRIPE_PRICE_PREMIUM_MONTH, STRIPE_PRICE_BUSINESS_MONTH, STRIPE_PRICE_BUSINESS_YEAR, STRIPE_PRICE_PREMIUM_YEAR,
//          APP_URL, SUPABASE_URL, SUPABASE_ANON_KEY
// Call: POST { plan: "pro"|"premium"|"business", billing: "monthly"|"yearly" } with the user's Supabase JWT. Returns { url }.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, apikey, x-client-info" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return json({ error: "unauthorized" }, 401);

  const { plan, billing } = await req.json().catch(() => ({}));
  if (!["pro", "premium", "business"].includes(plan) || !["monthly", "yearly"].includes(billing)) return json({ error: "bad_request" }, 400);
  const price = Deno.env.get(`STRIPE_PRICE_${plan.toUpperCase()}_${billing === "yearly" ? "YEAR" : "MONTH"}`);
  if (!price) return json({ error: "price_missing" }, 500);

  const app = Deno.env.get("APP_URL")!;
  const body = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": price,
    "line_items[0][quantity]": "1",
    client_reference_id: u.user.id,
    "subscription_data[metadata][user_id]": u.user.id,
    "subscription_data[metadata][plan]": plan,
    "subscription_data[metadata][billing]": billing,
    success_url: `${app}/?checkout=success`,
    cancel_url: `${app}/?checkout=cancel`,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const s = await r.json();
  return r.ok ? json({ url: s.url }) : json({ error: "stripe", detail: s?.error?.message }, 502);
});
