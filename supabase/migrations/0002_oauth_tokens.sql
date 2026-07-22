-- oauth_tokens — Alfy's own Google OAuth credentials (replaces Composio for Gmail/Calendar).
-- Service-role-only by design: no RLS policies at all. See PrymalAI-dashboard's
-- 20260720_oauth_rls_hotfix.sql for why a permissive policy here is a real incident,
-- not a hypothetical — an allow-all policy on the same kind of table was found
-- anonymously readable in that project and needed an emergency fix.
create table oauth_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users on delete cascade,
  platform      text not null,          -- 'gmail' | 'calendar' (more platforms in later phases)
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, platform)
);

alter table oauth_tokens enable row level security;
-- No policies: service-role only.
