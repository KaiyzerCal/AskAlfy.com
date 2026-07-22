-- standing_instructions — proactive, cron-driven checks ("never let me miss a birthday").
-- Schema only in this phase; no agent tools or automation runner wired up yet.
create table standing_instructions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users on delete cascade,
  goal_text      text not null,
  trigger_type   text not null default 'cron' check (trigger_type in ('cron', 'event')),
  trigger_config jsonb not null default '{"cadence":"daily"}',
  status         text not null default 'active' check (status in ('active', 'paused', 'cancelled')),
  last_run_at    timestamptz,
  last_result    text,
  created_at     timestamptz not null default now()
);

alter table standing_instructions enable row level security;
create policy standing_instructions_select_own on standing_instructions
  for select using (user_id = current_user_id());
