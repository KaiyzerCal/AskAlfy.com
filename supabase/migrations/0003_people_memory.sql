-- Extend "people" (Alfy knows) with richer contact memory, ported from PrymalAI's
-- contact_memory concept but folded into AskAlfy's existing table rather than a
-- parallel one — AskAlfy already has `people` serving this exact purpose.
alter table people rename column note to context_summary;

alter table people
  add column if not exists email           text,
  add column if not exists company         text,
  add column if not exists tags            text[] not null default '{}',
  add column if not exists birthday        text,          -- free text, e.g. "March 3" — year optional
  add column if not exists last_interaction timestamptz;

create index if not exists people_tags_idx on people using gin (tags);
create unique index if not exists people_user_email_idx on people (user_id, email) where email is not null;
