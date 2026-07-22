-- Per-user dedupe for the morning brief / evening debrief (alfy-digest, pg_cron-triggered
-- hourly like alfy-automation-runner). Stored as the person's own local date (computed from
-- users.timezone) so "already sent today" means their today, not UTC's.
alter table users
  add column if not exists last_brief_sent_date date,
  add column if not exists last_debrief_sent_date date;
