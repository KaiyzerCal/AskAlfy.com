-- Plan/trial/Stripe columns on users, plus the trial-usage-counting RPC. Tier shape is
-- Pally-style (pally.com: Free / Pro / Max, gated by usage ceiling, not by which feature you
-- unlock) rather than PrymalAI's per-Google-service tiers — every plan gets every tool, so
-- there's no feature matrix a person has to decode before they can use Alfy.
--
--   trial   — 7 days from signup, full access, capped (75 total actions, 20/day) — see
--             _shared/billing.ts's checkAccess for the exact gate logic.
--   active  — "Alfy" plan, full access, no counted cap.
--   plus    — "Alfy Plus" plan, same access, just the plan a heavy user lands on after
--             upgrading from active — not gated by any extra feature.
--   past_due / canceled — Stripe subscription lapsed; blocked until they resubscribe.
alter table users
  add column if not exists plan text not null default 'trial'
    check (plan in ('trial', 'active', 'plus', 'past_due', 'canceled')),
  add column if not exists trial_started_at timestamptz not null default now(),
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '7 days'),
  add column if not exists trial_actions_used int not null default 0,
  add column if not exists trial_daily_actions int not null default 0,
  add column if not exists trial_daily_reset_date date not null default current_date,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists users_stripe_customer_idx on users (stripe_customer_id)
  where stripe_customer_id is not null;

-- Called once per agent turn while a person is on trial (see _shared/billing.ts's
-- recordTrialAction). Rolls trial_daily_actions over when the reset date has passed,
-- otherwise increments it — same shape as PrymalAI's proven increment_trial_action.
create or replace function increment_trial_action(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update users
  set
    trial_daily_actions = case
      when trial_daily_reset_date = current_date then trial_daily_actions + 1
      else 1
    end,
    trial_daily_reset_date = current_date,
    trial_actions_used = trial_actions_used + 1
  where id = p_user_id;
end;
$$;
