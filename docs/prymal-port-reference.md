# Porting PrymalAI-dashboard's backend into AskAlfy.com — Reference

This doc is a complete spec of what to port, pulled from the working, deployed
PrymalAI-dashboard repo (`KaiyzerCal/prymalai-dashboard`). It exists so a fresh
Claude Code session working in the AskAlfy.com fork doesn't have to
reverse-engineer PrymalAI's backend from scratch.

**Direction:** keep AskAlfy's frontend, design system, phone-auth, 3-tab
dashboard, and SMS-deep-link approval flow exactly as-is. Port the backend
*capabilities* below into AskAlfy's own schema and Edge Functions. Do not
reuse PrymalAI's Supabase project — AskAlfy gets its own, per its own handoff
doc's instruction.

**Big architectural swap:** AskAlfy's `alfy-agent`/`alfy-approve` currently
call Google tools through Composio (2 action types, unverified). Replace that
with PrymalAI's proven hand-rolled Google OAuth + REST calls below (45 action
types, live-tested this session). Composio can stay reserved for future
non-Google apps (Slack/Notion/Linear), not for Google.

---

## 1. OAuth token refresh pattern (proven, copy as-is)

PrymalAI's `getFreshToken` (in `supabase/functions/prymal-chat/index.ts`):

```ts
async function getFreshToken(
  supabase: ReturnType<typeof createClient>,
  clientId: string,
  platform: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('prymal_oauth_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('client_id', clientId)
    .eq('platform', platform)
    .single()

  if (error || !data) return null

  const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : 0
  if (Date.now() < expiresAt - 60000) return data.access_token

  if (!data.refresh_token) return null

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refresh_token,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }),
  })
  const tokens = await res.json()
  if (!tokens.access_token) return null

  await supabase.from('prymal_oauth_tokens').update({
    access_token: tokens.access_token,
    expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
  }).eq('client_id', clientId).eq('platform', platform)

  return tokens.access_token
}
```

In AskAlfy: rename table references to whatever token table you create
(AskAlfy's `connections` table currently just stores a Composio pointer —
you'll need a real `oauth_tokens` table with `access_token`/`refresh_token`/
`expires_at` if you drop Composio for Google, since you'll own the OAuth app
directly instead of Composio brokering it).

**Platform values used:** `gmail`, `calendar`, `tasks`, `drive`, `docs`,
`sheets`, `slides`, `forms`, `keep`, `contacts`, `google` (used for GBP/Meet
which ride the base Google OAuth scope).

Google OAuth scopes needed per platform (from `src/pages/IntegrationsPage.tsx`):

```ts
const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.settings.basic', // needed for filters/auto-reply
  ],
  calendar: ['https://www.googleapis.com/auth/calendar'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  drive: ['https://www.googleapis.com/auth/drive.file'], // NOTE: only touches files the app created/opened — see gotcha below
  docs: ['https://www.googleapis.com/auth/documents'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  slides: ['https://www.googleapis.com/auth/presentations'],
  forms: ['https://www.googleapis.com/auth/forms'],
  keep: ['https://www.googleapis.com/auth/keep'],
  meet: ['https://www.googleapis.com/auth/calendar'],
  contacts: ['https://www.googleapis.com/auth/contacts'],
  gbp: ['https://www.googleapis.com/auth/business.manage'],
}
```

**Gotcha:** `drive.file` scope only lets the app touch files it created or
that the user explicitly opened with it — not the user's whole Drive. Full
Drive access needs the restricted `drive` scope, which requires a Google
security review (same track as the 100-user OAuth verification cap). Fine
for v1; flag it if "read my whole Drive" becomes a real ask.

---

## 2. The full action-type list (queue → execute two-step pattern)

PrymalAI's pattern: the agent's tool call **queues** an action into an
approval table with a `metadata` JSON blob; a separate approval executor
reads `metadata` and makes the real API call only after the human approves.
AskAlfy already has this shape (`approval_queue.action_payload` is the
`metadata` equivalent) — just needs the executor to actually implement each
`action_type`.

For each action type below: **tool name** (what the agent calls) → **metadata
keys stored** → **what the executor must do with them**.

### Gmail (needs `gmail` token)

| action_type | metadata keys | Executor behavior |
|---|---|---|
| `send_email` | `to`, `cc`, `bcc`, `subject` (body = draft_content) | Build RFC2822 raw message, POST `gmail/v1/users/me/messages/send` |
| `create_label` | `name`, `labelListVisibility`, `messageListVisibility` | POST `gmail/v1/users/me/labels` |
| `apply_label` | `threadIds[]`, `labelName` | Resolve label name→id (create if missing), POST `threads/{id}/modify` with `addLabelIds` for each thread |
| `remove_label` | `threadIds[]`, `labelName` | Same but `removeLabelIds` |
| `archive_email` | `threadIds[]` | `threads/{id}/modify` with `removeLabelIds: ['INBOX']` |
| `mark_as_read` | `threadIds[]` | `removeLabelIds: ['UNREAD']` |
| `mark_as_unread` | `threadIds[]` | `addLabelIds: ['UNREAD']` |
| `delete_email` | `threadIds[]` | Prefer `threads/{id}/trash` (reversible) over permanent delete |
| `create_filter` | `from`, `to`, `subject`, `query`, `action` (`archive`\|`markRead`\|`star`\|`delete`), `label` | Build `criteria`/`action` objects, POST `gmail/v1/users/me/settings/filters` |
| `set_auto_reply` | `message`, `subject`, `startTime`, `endTime`, `restrictToContacts`, `restrictToDomain` | PUT `gmail/v1/users/me/settings/vacation` |
| `schedule_send` | `to`, `cc`, `bcc`, `subject`, `sendAt` | **Gmail API has no scheduled-send** — save as a draft (`gmail/v1/users/me/drafts`) and tell the user to use Gmail's own Schedule Send UI |

Read-only tools (no approval needed, agent calls directly):
`get_emails` (search, `q` param), `get_email_thread` (full thread by id),
`list_labels`.

### Calendar (needs `calendar` token)

| action_type | metadata keys | Executor |
|---|---|---|
| `create_event` | `title`, `startTime`, `endTime`, `location`, `attendees[]`, `description` | POST `calendar/v3/calendars/primary/events` |
| `update_event` | `eventId` + any of the above | PATCH same endpoint `/{eventId}` |
| `delete_event` | `eventId` | DELETE same endpoint |
| `schedule_meet` | `title`, `startTime`, `endTime`, `attendees[]`, `description` | POST events endpoint with `conferenceData.createRequest` (`conferenceDataVersion=1` query param), returns `hangoutLink` |

Read-only: `get_calendar_events` (`timeMin`/`timeMax`/`maxResults`),
`get_availability`.

### Google Tasks (needs `tasks` token)

| action_type | metadata keys | Executor |
|---|---|---|
| `create_task` | `title`, `description`, `dueDate` | POST `tasks/v1/lists/@default/tasks` |
| `update_task` | `taskId`, `title`, `description`, `dueDate`, `status` | PATCH `.../tasks/{taskId}` |
| `complete_task` | `taskId` | PATCH with `status: 'completed'` |

Read-only: `list_tasks`.

### Google Drive (needs `drive` token)

| action_type | metadata keys | Executor |
|---|---|---|
| `create_folder` | `name`, `parentFolderId` | POST `drive/v3/files` with `mimeType: application/vnd.google-apps.folder` |
| `move_file` | `fileId`, `targetFolderId` | GET current `parents`, then PATCH `?addParents=X&removeParents=<old>` |
| `rename_file` | `fileId`, `newName` | PATCH `drive/v3/files/{fileId}` body `{name}` |
| `delete_file` | `fileId`, `permanently` (bool) | DELETE if permanent, else PATCH `{trashed: true}` |
| `share_file` | `fileId`, `emailAddresses[]`, `role`, `sendNotification` | POST `drive/v3/files/{fileId}/permissions` once per address |
| `set_permissions` | `fileId`, `type` (`anyone`\|`user`\|...), `role`, `value` (email if type=user) | Same permissions endpoint, one call |

Read-only: `search_drive_files`, `read_drive_file`, `list_drive_files`,
`get_file_info`, `analyze_file`.

### Docs / Sheets / Slides (need `docs`/`sheets`/`slides` token respectively — Drive create endpoint covers creation)

| action_type | metadata keys | Executor |
|---|---|---|
| `create_document` | `title`, `content`, `parentFolderId` | POST `drive/v3/files` with `mimeType: application/vnd.google-apps.document`; if `content`, follow with `docs/v1/documents/{id}:batchUpdate` `insertText` at index 1 |
| `update_document` | `documentId`, `content`, `mode` (`append`\|`replace`) | GET doc body to find end index, `batchUpdate` `insertText` (append) |
| `create_sheet` | `title`, `parentFolderId` | POST `drive/v3/files` mimeType `application/vnd.google-apps.spreadsheet` |
| `update_sheet` | `spreadsheetId`, `sheetName`, `range`, `values` (2D array), `mode` (`append`\|`overwrite`) | `sheets/v4/spreadsheets/{id}/values/{range}` PUT or `:append` POST, `valueInputOption=USER_ENTERED` |
| `create_slide` | `title`, `parentFolderId` | POST `drive/v3/files` mimeType `application/vnd.google-apps.presentation` |
| `update_slide` | `presentationId`, `slideIndex`, `title`, `content` | `slides/v1/presentations/{id}:batchUpdate` — `slides API text placement is limited`, keep expectations modest here |

Read-only: `read_document`, `delete_document`, `read_sheet`, `delete_sheet`,
`read_presentation`, `delete_presentation` (deletes go through Drive's
`files/{id}` DELETE/trash, same as `delete_file`).

### Google Forms / Keep (needs `forms`/`keep` token)

Lower priority — CRUD exists in PrymalAI (`create_form`, `read_form`,
`list_form_responses`, `delete_form`, `create_note`, `list_notes`,
`update_note`, `delete_note`) but these are niche. Port last, or skip for v1.

### Google Contacts (needs `contacts` token)

| action_type | metadata keys | Executor |
|---|---|---|
| `create_contact` | `givenName`, `familyName`, `email`, `phone`, `company`, `jobTitle`, `notes` | POST `people.googleapis.com/v1/people:createContact` |
| `update_contact` | `resourceName` + fields | `people.googleapis.com/v1/{resourceName}:updateContact` |
| `delete_contact` | `resourceName` | DELETE `people.googleapis.com/v1/{resourceName}:deleteContact` |

Read-only: `list_contacts`, `get_contact`, `search_contacts`.

### Google Meet / GBP / Photos

`schedule_meet`/`cancel_meeting` covered under Calendar above.
GBP (`respond_to_review`, `create_post`) and Photos (`upload_photo`,
`create_album`, `organize_photos`, `find_duplicate_photos`,
`delete_duplicate_photos`, `auto_organize_photos`) exist in PrymalAI but are
lower priority for an SMS-first consumer product — evaluate whether AskAlfy's
target user needs these at all before porting.

---

## 3. Plan tiers (if AskAlfy keeps a paid-tier model)

PrymalAI's tier structure (`src/lib/tierConfig.ts`), gate every tool call
with `requirePlan(tier, featureName)`:

| Tier | Price | Unlocks |
|---|---|---|
| free | $0 | Dashboard only, no agent access |
| tier1 | $17/mo | Gmail |
| tier2 | $47/mo | + Calendar, Tasks |
| tier3 | $97/mo | + Drive, Docs, Sheets, Slides, Forms, Keep, Places |
| tier4 | $147/mo | + Meet, Contacts, Photos, Business Profile |

Plus a **$5 / 7-day trial** tier with a hard cap: 75 total AI actions, 20/day
soft cap, tracked via `trial_actions_used`/`trial_daily_actions`/
`trial_daily_reset_date` columns and an `increment_trial_action` Postgres RPC
called after every successful model turn. Whether AskAlfy wants this exact
trial mechanic or something simpler is a product call — flagging it exists
and is proven, not mandating it.

Stripe wiring: `prymal-stripe-checkout` (creates Stripe customer + checkout
session per plan) and `prymal-stripe-webhook` (listens for
`checkout.session.completed`, `customer.subscription.updated/deleted`,
updates the plan column). Straightforward to port; adapt table/column names
to AskAlfy's `users` table.

---

## 4. Standing instructions (proactive, cron-driven checks)

The "never let me miss a birthday" feature. Schema:

```sql
create table standing_instructions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  goal_text text not null,
  trigger_type text not null default 'cron' check (trigger_type in ('cron','event')),
  trigger_config jsonb not null default '{"cadence":"daily"}',
  status text not null default 'active' check (status in ('active','paused','cancelled')),
  last_run_at timestamptz,
  last_result text,
  created_at timestamptz default now()
);
```

Agent tools: `create_standing_instruction({goal_text, cadence})`,
`list_standing_instructions()`, `cancel_standing_instruction({id})`. The
agent stores the goal verbatim — no special-cased logic per goal type.

A scheduled Edge Function (`prymal-automation-runner` in PrymalAI) finds
instructions due per their cadence (`hourly`/`daily`/`weekly` — use ~55min/
~23hr/~6.8day windows so a cron tick always qualifies), and **re-invokes the
main agent loop headlessly** with a synthetic message:

```
Scheduled check of a standing instruction. Today is {date}.
The client's ongoing goal: "{goal_text}"
Look at the current state with your tools and decide whether anything needs
doing today to honor this goal. If yes, act (external actions still go
through the approval queue). If not, reply NO_ACTION.
```

Driven by `pg_cron` + `pg_net` (both built into Supabase, no new infra):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'alfy-automation-hourly', '5 * * * *',
  $$ select net.http_post(
       url := 'https://<project>.supabase.co/functions/v1/<runner-fn>',
       headers := '{"Content-Type":"application/json","x-runner-key":"<secret>"}'::jsonb,
       body := '{}'::jsonb
     ); $$
);
```

The runner authenticates to the main agent function via a shared-secret
header (`x-internal-key` in PrymalAI, checked against an
`INTERNAL_FUNCTION_SECRET` env var) rather than a user JWT, since there's no
human session for a scheduled run. **Critically**: in "automation mode" the
agent must be told it's unattended and forbidden from self-approving queued
actions — this is a prompt-injection guard (a scheduled run should never be
able to both draft AND approve an outbound action with no human in the
loop).

Birthday-specific: extend the contacts table with a `birthday` column (free
text, e.g. `"March 3"` — year optional) so the agent can capture it whenever
mentioned, then the standing instruction "never let me miss a birthday"
checks that column against today's date on each run and, if found, creates
a **recurring yearly** calendar event (self-sustaining, no need to re-check
logic every year) plus a queued nudge — never auto-sends the "happy
birthday" message itself.

---

## 5. Contact/relationship memory

PrymalAI's schema (richer than AskAlfy's `people` table — one free-text note
only):

```sql
create table contact_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  contact_email text not null,
  contact_name text,
  company text,
  context_summary text,       -- agent rewrites this to stay current, doesn't append forever
  tags text[] default '{}',
  birthday text,
  last_interaction timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, contact_email)
);
create index on contact_memory using gin (tags);
```

Tools: `remember_contact({contact_email, contact_name, company,
context_summary, tags, last_interaction, birthday})` (upsert on
`user_id,contact_email`), `recall_contacts({query, tag, stale_days, limit})`
— free-text search across name/email/company/context plus a
"haven't-spoken-in-N-days" filter for reconnection prompts.

System prompt instruction: update this quietly after any meaningful email/
meeting interaction; don't announce it every time; rewrite `context_summary`
rather than let it grow unbounded.

---

## 6. Follow-up detection & meeting prep (compose from tools above, no new APIs)

**`find_followups_needed`**: scans `in:sent` Gmail threads within a lookback
window; for each thread, checks if the *last* message was sent by the user
and is older than a threshold (e.g. 3+ days) — if so, it's "waiting on a
reply." Pure composition of the Gmail read API, no new endpoint.

**`meeting_prep`**: for upcoming calendar events, pulls each attendee's
email history (`from:X OR to:X`, last 3 messages) + their `contact_memory`
row, assembles a per-attendee brief. Composition of Calendar read + Gmail
read + contact_memory read.

**Daily brief**: not a separate API — it's a system-prompt *recipe*
instructing the agent to compose unread mail + today's calendar + tasks due
+ `find_followups_needed` into one message when asked for "morning brief"
or similar. In PrymalAI this is also a UI button that fires the same prompt
programmatically.

---

## 7. Twilio inbound (AskAlfy's version has this as an unverified TODO — here's the proven implementation)

AskAlfy's `alfy-sms-inbound/index.ts` has a `// TODO(VERIFY): validate
X-Twilio-Signature` — PrymalAI's is implemented and live-tested:

```ts
async function validateTwilioSignature(req: Request, params: Record<string, string>): Promise<boolean> {
  const signature = req.headers.get('x-twilio-signature')
  if (!signature || !TWILIO_AUTH_TOKEN) return false
  const url = new URL(req.url)
  const publicUrl = `https://${url.host}${url.pathname}${url.search}`
  const sorted = Object.keys(params).sort().map(k => k + params[k]).join('')
  const data = publicUrl + sorted
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return expected === signature
}
```

Twilio send (also proven, same shape AskAlfy already has correct):

```ts
await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + btoa(`${SID}:${TOKEN}`),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ From: FROM, To: to, Body: bodyText }),
})
```

**Gotcha for long replies**: SMS has practical length limits — PrymalAI
splits replies into up to 3 chunks of 1500 chars. AskAlfy's system prompt
already asks Alfy to keep replies to 5 lines max, which mostly avoids this,
but keep the chunking as a safety net.

---

## 8. Gotchas hit this session (avoid repeating them)

1. **CORS**: if you lock `Access-Control-Allow-Origin` to a strict allowlist,
   any origin not on it gets "Failed to fetch" in the browser with zero
   useful error surfaced anywhere. Since these endpoints already authenticate
   via Bearer JWT (or a shared secret for server-to-server calls), the origin
   check is defense-in-depth, not the real gate — default to reflecting the
   caller's origin, only enforce a strict allowlist if you explicitly opt in
   via an env var.
2. **Large function deploys are flaky.** A ~150KB `index.ts` (the fully
   Gmail/Calendar/Drive-loaded agent function will get here) intermittently
   fails Supabase's `--use-api` bundler with a generic 500. Wrap `supabase
   functions deploy` in a retry loop (3-5 attempts with backoff) in CI —
   don't assume one failed deploy means broken code.
3. **Copy-paste merge artifacts are silent killers.** Two separate incidents
   this session: a stripped regex backslash + unescaped apostrophe in a
   string, and an orphaned object literal left behind when a `console.log(`
   line was deleted — both caused total function bundle failure with a
   *specific* line/column error, not a vague one. Before trusting a "code
   parses" assumption, actually run `npx esbuild <file> --bundle
   --platform=neutral --external:npm:* --outfile=/dev/null` on every function
   after any merge — catches every syntax error in one pass, cheaper than
   waiting on a live deploy failure.
4. **GitHub Actions secret must exist before first push, or every deploy
   silently no-ops** with "Access token not provided" and exit 1 in under a
   second — easy to mistake for a code problem when it's actually a missing
   `SUPABASE_ACCESS_TOKEN` repo secret.
5. **Don't assume duplicate merge branches collapsed correctly.** If two
   people (or two sessions) both add an executor for the same `action_type`
   during a merge, only the *first* matching `if/else if` branch runs — the
   second is silently dead code. Grep for `actionType === '<type>'` counts
   after any merge; anything >1 needs manual reconciliation, and check which
   branch actually reads the metadata keys the tool call *actually* stores
   (they can drift independently).

---

## Suggested first move for the new session

Don't try to port everything in one pass. Suggested order:
1. Stand up the new Supabase project, run AskAlfy's `0001_alfy_core.sql`
2. Add migrations for `contact_memory` (birthday/tags/company),
   `standing_instructions`, and a real Google `oauth_tokens` table
3. Replace `alfy-agent`'s Composio tool calls with Gmail + Calendar tools
   only (send_email, get_emails, create_event, get_calendar_events) — get
   the smallest working slice deployed and SMS-tested end to end first
4. Then widen to the rest of Gmail CRUD, then Calendar CRUD, then Drive/Docs/
   Sheets, then standing instructions + automation runner, then billing
5. Verify Twilio signature checking and the OAuth connect flow against live
   accounts before trusting anything — this repo's handoff doc explicitly
   flagged those as unconfirmed
