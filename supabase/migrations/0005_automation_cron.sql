-- Enables the extensions the standing-instructions automation runner needs. Both are
-- built into Supabase — no new infra.
--
-- The actual cron.schedule(...) call that wires pg_net to alfy-automation-runner is NOT
-- in this file, because it has to carry the shared secret (x-runner-key) pg_net sends as
-- a literal in its SQL body, and that secret must never be committed to git. It was
-- registered once, live, directly against the project. To reproduce on a fresh project,
-- see docs/alfy-handoff.md for the exact statement with a placeholder for the secret —
-- generate a new one, run it live, and set the same value as the INTERNAL_FUNCTION_SECRET
-- edge-function secret.
create extension if not exists pg_cron;
create extension if not exists pg_net;
