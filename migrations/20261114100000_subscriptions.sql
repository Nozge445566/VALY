-- Subscriptions: one row per user. Written ONLY by the Stripe webhook (service role). Users can read their own row.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','plus','premium')),
  billing text check (billing in ('monthly','yearly')),
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own" on public.subscriptions
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies on purpose: only the service role (webhook) writes.
