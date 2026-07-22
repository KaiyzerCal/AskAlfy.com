# Alfy — Handoff for the last session

This repo is built to **near-completion**. Every line of code is here. The remaining work is
**account setup, secrets, deploy, and verifying a short list of external API calls** — no new
architecture. Fork it and finish.

**Update — Phase 1 backend port (see `docs/prymal-port-reference.md`):** Gmail + Calendar no
longer go through Composio. AskAlfy now owns a real Google OAuth app and talks to the Gmail
and Calendar REST APIs directly (pattern ported from PrymalAI-dashboard's proven backend).
A fresh Supabase project (`askalfy`, ref `kpybomnunyhazkenyoeb`) has been provisioned for
this and carries the extended schema (`oauth_tokens`, richer `people`, `standing_instructions`
in addition to the original `0001_alfy_core.sql` tables). PrymalAI-dashboard's own Supabase
project has been paused — AskAlfy replaces it going forward. Composio stays in the dependency
tree for future non-Google apps only; it is not called anywhere in Phase 1's code path.

---

## The accounts (the only things code can't do for itself)

1. **Supabase** — done for Phase 1: the `askalfy` project already exists. Copy its URL +
   anon key into `.env.local`.
2. **Twilio** — a phone number + A2P 10DLC registration (the number *is* the product).
3. **Google Cloud OAuth client** — a **Web application** OAuth 2.0 client (own the app so
   tokens belong to Alfy directly, no third party in between). Register redirect URI
   `${PUBLIC_APP_URL}/auth/google-callback`. Composio is no longer used for Gmail/Calendar —
   this replaces steps 3 ("Composio") from the original four-account list.
4. **Anthropic** — one platform API key (consumers can't paste a key over SMS).

---

## What's already done (do not rebuild)

| Layer | Status | Where |
|---|---|---|
| Marketing site | ✅ done | `src/pages/index.astro` + `src/components/*` |
| Dashboard — 3 tabs (Today / Handled / Alfy knows) | ✅ done, interactive | `src/components/AlfyDashboard.tsx` |
| Weekly breakdown + range control (in Handled) | ✅ done | same |
| Login — phone OTP, Jobs-cut | ✅ done | `src/components/LoginForm.tsx`, `src/pages/login.astro` |
| Data layer (Supabase + demo fallback) | ✅ done | `src/lib/queue.ts`, `src/lib/supabase.ts` |
| DB schema + RLS + link-approval | ✅ done | `supabase/migrations/0001-0004_*.sql` |
| Agent loop (Gmail/Calendar tools + "asks first" queue) | ✅ scaffold | `supabase/functions/_shared/agent.ts` |
| SMS inbound webhook + onboarding on "YES" | ✅ done | `supabase/functions/alfy-sms-inbound/` (Twilio signature now enforced) |
| Magic-link handler (session mint) | ✅ done | `supabase/functions/alfy-link/` |
| `/a` handoff page (token → session → deep-link) | ✅ done | `src/pages/a.astro`, `src/components/AuthHandoff.tsx` |
| Approval executor | ✅ scaffold | `supabase/functions/alfy-approve/` (~28 action_types across Gmail/Calendar/Tasks/Drive/Docs/Sheets; anything else fails gracefully) |
| Google OAuth connect flow | ✅ scaffold | `supabase/functions/alfy-connect/`, `src/pages/auth/google-callback.astro` + Settings button (one consent screen, all scopes) |
| Approve button → executes | ✅ done | `src/lib/queue.ts` (`approveItem` → `alfy-approve`) |

"Scaffold" = complete structure, correct DB logic, external API calls marked `VERIFY`.
"Done" = uses documented APIs, no open calls.

**Auth model:** onboarding creates one `auth.users` with both the phone AND a synthetic email
(`<digits>@sms.askalfy.com`). Typed login → phone OTP. SMS deep-link → email-style magic link
via that synthetic email. Both resolve to the same account.

---

## The last session, step by step

1. **Supabase project** — already done (`askalfy`, ref `kpybomnunyhazkenyoeb`). Copy its URL +
   anon key into `.env.local` (`PUBLIC_SUPABASE_*`). Migrations `0001`-`0004` are already
   applied to it.
2. **Set function secrets** (see `.env.local.example` list) via `supabase secrets set` —
   `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are new; `COMPOSIO_*` are no longer needed.
3. **Deploy functions:** `supabase functions deploy alfy-agent alfy-sms-inbound alfy-link alfy-approve alfy-connect alfy-automation-runner alfy-digest alfy-stripe-checkout alfy-stripe-webhook`.
4. **Google Cloud OAuth client:** create a Web application OAuth client, register redirect
   URI `${PUBLIC_APP_URL}/auth/google-callback`, put the client ID (also hardcode in
   `src/lib/config.ts`'s `GOOGLE_CLIENT_ID`) and secret in Supabase function secrets.
5. **Twilio:** buy a number → register A2P 10DLC → point the number's inbound webhook at the
   `alfy-sms-inbound` function URL → put SID/token/number in secrets.
6. **Supabase phone auth:** Auth → Providers → Phone → **Twilio** (so login codes send).
7. **The number:** set `ALFY_PHONE` in `src/lib/config.ts` to the real Twilio number.
8. Set `PUBLIC_APP_URL`, deploy the site (Vercel/Netlify), smoke-test the loop below.

**Smoke test:** text the number → get a reply + an `Approve:` link → tap it → land on the
pending card → tap Approve → action fires → confirmation text arrives. For Gmail/Calendar
actions specifically, connect Google first from Settings → Connections.

---

## VERIFY checklist (the only unproven calls — needs live credentials, see
## `docs/prymal-port-reference.md` §9 for what's already self-verified)

- [ ] **Google OAuth token exchange + refresh** (`alfy-connect`, `_shared/google.ts`) against
      a real GCP OAuth client — redirect URI must match exactly, and the single consent
      screen must actually grant all 6 scopes (gmail/calendar/tasks/drive.file/docs/sheets).
- [ ] **Gmail/Calendar/Tasks/Drive/Docs/Sheets REST calls** (`_shared/google.ts`) against a
      real connected Google account — Phase 3 widened this from just Gmail send/read +
      Calendar create/read to the full ~28-action_type set; none of it has hit a live API yet.
- [ ] **Twilio signature** verification in `alfy-sms-inbound` (now implemented — verify
      against a live Twilio webhook, not just unit logic).
- [ ] **Twilio send** (Messages API basic-auth) — confirm creds/format.
- [ ] **`alfy-automation-runner`** — the cron job (hourly, `:05`) is already registered live;
      it currently has nothing to authenticate with until `INTERNAL_FUNCTION_SECRET` is set as
      an edge-function secret to match the value baked into the live `cron.schedule(...)` call.
- [ ] **Stripe** — create the Stripe account, two Products (Alfy / Alfy Plus) with recurring
      Prices, set `STRIPE_SECRET_KEY`/`STRIPE_PRICE_ALFY`/`STRIPE_PRICE_ALFY_PLUS`, register a
      webhook endpoint pointed at `alfy-stripe-webhook`'s URL listening for
      `checkout.session.completed`, `customer.subscription.created/updated/deleted`, copy its
      signing secret into `STRIPE_WEBHOOK_SECRET`. None of `alfy-stripe-checkout`/
      `alfy-stripe-webhook`'s live calls have hit a real Stripe account yet.
- [ ] **`alfy-digest`** — the cron job (hourly, `:10`) is registered live using the same
      `x-runner-key` secret as automation-runner, so it needs the same
      `INTERNAL_FUNCTION_SECRET` above to actually authenticate. Once real Twilio/Anthropic/
      Google credentials exist, confirm a morning brief and evening debrief actually land —
      the local-time window math (`getLocalParts`/`zonedTimeToUtc` in `alfy-digest/index.ts`)
      hasn't been checked against a real `users.timezone` value yet.
- [ ] **Standing-permission auto-execute** — `_shared/agent.ts`'s `queue()` auto-execute
      branch and `grant_standing_permission` haven't fired against a live Google account
      yet; confirm a granted permission actually skips the ask and executes on the next
      matching action, with the confirmation text landing in the same reply.

(Session mint in `alfy-link` is resolved — documented `generateLink` + `verifyOtp` pattern.
Composio's connect/tool-execute calls are no longer part of this path — see the Phase 1
update at the top of this doc.)

**Phase 2 update:** the rest of Gmail (labels, archive/read-state, filters, vacation
auto-reply, schedule-send-as-draft) and Calendar (update/delete/`schedule_meet`,
`get_availability`) are now wired end to end, each as its own agent tool queued through
`approval_queue` and executed by `alfy-approve`. `remember_contact`/`recall_contacts` read
and write the extended `people` table directly (not queued — it's memory, not an outbound
action). The "Alfy knows" tab now reads real `people`/`standing_permissions` data instead
of hardcoded demo constants, and its Trust "revoke" button actually revokes.

**Phase 3 update:** Tasks (`list_tasks`, `create_task`, `update_task`, `complete_task`),
Drive (`search_drive_files`, `get_file_info`, `read_drive_file`, `create_folder`,
`move_file`, `rename_file`, `delete_file`, `share_file` — covers both per-person sharing
and "anyone with the link"), and Docs/Sheets (`read_document`, `read_sheet`,
`create_document`, `update_document`, `create_sheet`, `update_sheet`) are now wired end to
end the same way as Gmail/Calendar. The "Connect Google" flow was simplified to a single
consent screen covering all six scopes at once (`src/lib/config.ts`'s `GOOGLE_SCOPES`) — one
access/refresh token pair gets stored under all 6 `oauth_tokens` platform rows, rather than
requiring six separate OAuth round-trips. `drive.file` scope means Alfy can only see files it
created or the person explicitly opened with it, not the whole Drive (see gotcha in
`docs/prymal-port-reference.md` §1) — full Drive access needs a Google security review.

**Phase 4 update:** standing instructions are now wired end to end. Three new agent tools —
`create_standing_instruction`, `list_standing_instructions`, `cancel_standing_instruction` —
let a person set up an ongoing check ("never let me miss a birthday") that isn't an outbound
action, just a row in `standing_instructions` (schema was already in place from Phase 1). A
new edge function, `alfy-automation-runner`, is `pg_cron`-triggered hourly: it selects
`status = 'active'` instructions whose cadence (`hourly`/`daily`/`weekly`, stored in
`trigger_config`) means they're due, and re-invokes `runAgent` headlessly with a synthetic
"automation mode" prompt telling the model no human is present so it shouldn't ask a
question — just look, decide, and act (or reply `NO_ACTION`). External actions triggered this
way still go through the normal `approval_queue`/`alfy-approve` flow — nothing about the
"nothing leaves without a yes" invariant changes for scheduled runs. Auth for the runner is a
shared secret (`x-runner-key` header / `INTERNAL_FUNCTION_SECRET`), not a user JWT, since
there's no human session for a cron-triggered call; the function is deployed with
`verify_jwt: false` and checks the header itself. AskAlfy's agent has no self-approve tool at
all (unlike PrymalAI's `resolve_pending_action`), so there's no tool to strip for
prompt-injection safety on unattended runs — the guard is architectural, not per-invocation.

**Reproducing the cron registration on a fresh project:** `0005_automation_cron.sql` only
enables the `pg_cron`/`pg_net` extensions (secret-free, safe to commit). The actual
`cron.schedule(...)` call has to embed the shared secret as a literal in the SQL body (that's
how `pg_net` passes headers), so it was applied once, live, directly against the project —
never committed. To reproduce:

```sql
select cron.schedule(
  'alfy-automation-runner-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://kpybomnunyhazkenyoeb.supabase.co/functions/v1/alfy-automation-runner',
    headers := jsonb_build_object('x-runner-key', '<same value as INTERNAL_FUNCTION_SECRET>'),
    body := '{}'::jsonb
  );
  $$
);
```

Generate a new random string for `<same value as INTERNAL_FUNCTION_SECRET>`, run this live via
the SQL editor (or `execute_sql`), and set the identical value as the `INTERNAL_FUNCTION_SECRET`
edge-function secret.

**Phase 5 update:** billing is wired end to end. Tier shape follows pally.com (an SMS/
iMessage-first assistant, the closest real analog to Alfy) rather than PrymalAI's — Pally
gates by usage ceiling (Free / Pro $25 / Max $200), not by which Google service you've
unlocked, so every Alfy plan gets every tool and there's no feature matrix to decode before
texting Alfy. Structure: a 7-day trial (75 total actions hard cap, 20/day soft cap — ported
as-is from PrymalAI's proven mechanic), then **Alfy** ($25/mo, `STRIPE_PRICE_ALFY`) or
**Alfy Plus** ($75/mo, `STRIPE_PRICE_ALFY_PLUS`) for heavier users — Plus is a usage-ceiling
upsell only, not a feature unlock. Prices are placeholders in `_shared/billing.ts` /
`AlfyDashboard.tsx`'s `PLAN_LABEL` — change them in one place once real pricing is decided.

New `users` columns (`0006_billing.sql`): `plan`, `trial_started_at`, `trial_ends_at`,
`trial_actions_used`, `trial_daily_actions`, `trial_daily_reset_date`, `stripe_customer_id`,
`stripe_subscription_id`, plus an `increment_trial_action` RPC.

`_shared/billing.ts` is the single gate: `checkAccess(supa, userId)` runs before every agent
turn (both `alfy-sms-inbound` and `alfy-automation-runner` call it) and returns
allowed/blocked with a reason. A blocked SMS turn never touches a tool — it gets one paywall
text (Alfy's voice, `paywallCopy`) with a Stripe Checkout link instead. A blocked standing
instruction is skipped silently by the cron runner (no SMS from a background job) and picks
back up on the very next hourly tick once the person resubscribes, rather than waiting out
the full cadence window. Trial users get `recordTrialAction` called after every turn that
actually ran — standing instructions on trial count against the same caps as texted turns,
so an hourly cadence can't become an unmetered way around them.

Two new edge functions, both hand-rolled REST (no Stripe SDK, matching the rest of the
codebase's Twilio/Google pattern):
- **`alfy-stripe-checkout`** — JWT-authenticated, called from the dashboard's Billing row.
  Mints a Checkout Session if the account has no subscription yet, or a Billing Portal
  session (Stripe's own hosted manage/cancel/upgrade page) if it already does — one button,
  server decides which.
- **`alfy-stripe-webhook`** — `verify_jwt: false`, authenticates via the `Stripe-Signature`
  header instead (HMAC-SHA256, same shape as Twilio's signature check, different algorithm).
  `customer.subscription.*` is the single source of truth for `users.plan`.

Dashboard: Settings → Billing (already had a placeholder row) now shows real state — trial
countdown in plain days-left language (no raw action-count exposed, matching Pally's
"generous allowances" framing over a scary counter), or the current plan name, with a
marigold "Upgrade"/"Reactivate" button or a plain "Manage" link depending on state.

**Phase 6 update:** the closed loop — morning brief through evening debrief — plus live
graduated autonomy, per Chris's product direction (repeated approvals should be able to earn
Alfy more autonomy over time, not stay a permanent ask-every-time loop).

- **Standing permissions are now live**, not just a revoke-only list in the dashboard.
  `_shared/executors.ts` is a new module — the `action_type → real Google API call` switch
  extracted out of `alfy-approve` — so both the human-tap path and a new auto-execute path
  can replay the exact same executors. `_shared/agent.ts`'s `queue()` now checks for an
  active `standing_permissions` row for the exact `action_type` before inserting a pending
  approval; if one exists, it executes immediately (still logged in `approval_queue` as
  `executed`, tagged with `standing_permission_id`, still confirmed in the reply) instead of
  waiting on a tap. The "ask first" invariant isn't broken — the yes already happened, once,
  when the permission was granted; it's just durable now instead of per-action.
- **`get_context` gained `autonomy_candidates`**: `action_type`s approved 3+ times in the
  last 30 days with no standing permission yet. A new `grant_standing_permission` tool lets
  the model turn one into a live permission, but only after the person clearly says yes in
  that same exchange (system prompt rule 6) — it may offer, once per reply, never nag, and
  has no memory of a declined offer across separate texts (each SMS turn is still stateless
  by design, see `alfy-sms-inbound`'s `runAgent` call passing no history).
- **`alfy-digest`** (new function, `pg_cron` hourly, same shared-secret pattern as
  `alfy-automation-runner`) sends a morning brief and an evening debrief, both built
  deterministically from the DB — no extra Claude call, since a fixed-shape summary doesn't
  need one. Morning: what's pending, what standing instructions are being watched, today's
  calendar. Evening: what got handled today (including auto-executed standing-permission
  items), what's still waiting. Windows are computed in each person's own `users.timezone`
  (a from-scratch local-day/local-hour implementation, since Deno has no timezone library),
  checked every hour rather than scheduled per-timezone, with `last_brief_sent_date`/
  `last_debrief_sent_date` (`0007_digest.sql`) deduping across the ~3 hourly ticks inside
  each window. Respects the person's own quiet-hours setting and the billing gate — no
  proactive text to a blocked account.
- Cron registration (same live-only, not-committed-to-git pattern as Phase 4's automation
  cron — see `0005_automation_cron.sql`'s comment): a second `cron.schedule()` call,
  `alfy-digest-hourly` at `10 * * * *` (offset from automation-runner's `5 * * * *`),
  reusing the same `x-runner-key` secret value already registered for automation-runner —
  `INTERNAL_FUNCTION_SECRET` is one shared secret across both scheduled functions.

**Not built yet:** nothing from the reference doc's roadmap remains. Slides/Forms/Keep were
judged niche and skipped per the reference doc's own call. Chris's morning-brief/evening-
debrief + graduated-autonomy direction (Phase 6, above) is now built too.

---

## Branding — non-negotiable, must match what's built (see `/CLAUDE.md`)

The finishing session must preserve the design constitution exactly:

- **Only three dashboard sections:** Today, Handled, Alfy knows. Do not add a fourth.
- **Palette (hardcoded, never substitute):** linen `#FAF5EC`, card `#FFFDF8`, hairline
  `#E7DFD0`, espresso `#2E2A24`, marigold `#E08A2E` (primary action only), **fern `#4E7D68`
  reserved for approval/trust moments only**. No purple, neon, gradients, glassmorphism.
- **Type:** Fraunces (headlines only), Inter (everything else). Self-hosted.
- **Voice:** plain words, contractions, no exclamation marks, no emoji, sentence case,
  sign-off "— A". Never "AI-powered" — Alfy is "an assistant."
- **The law:** nothing leaves without a yes. The approval queue + link flow *is* the product.
  Fern = granted trust. Keep it grandmother-comprehensible.

Any new screen inherits `src/styles/global.css` tokens and the card/`label-caps`/`card-lift`
patterns already used in `AlfyDashboard.tsx`. Match, don't reinvent.
