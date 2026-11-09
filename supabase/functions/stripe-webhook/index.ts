// Stripe webhook -> public.subscriptions. SKELETON: needs secrets, not deployed or tested.
// Secrets: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Deploy with --no-verify-jwt.
// Events to enable in Stripe: customer.subscription.created / updated / deleted.
import { createClient } from "npm:@supabase/supabase-js@2";

async function verify(raw: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === v1;
}

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verify(raw, req.headers.get("stripe-signature") ?? "", Deno.env.get("STRIPE_WEBHOOK_SECRET")!))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw);
  if (!String(event.type).startsWith("customer.subscription.")) return new Response("ignored");
  const sub = event.data.object;
  const userId = sub.metadata?.user_id;
  if (!userId) return new Response("no user", { status: 200 });

  const deleted = event.type === "customer.subscription.deleted" || sub.status === "canceled";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await admin.from("subscriptions").upsert({
    user_id: userId,
    plan: deleted ? "free" : sub.metadata?.plan ?? "free",
    billing: deleted ? null : sub.metadata?.billing ?? null,
    status: deleted ? "canceled" : sub.status === "past_due" ? "past_due" : "active",
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    updated_at: new Date().toISOString(),
  });
  return new Response(error ? error.message : "ok", { status: error ? 500 : 200 });
});
