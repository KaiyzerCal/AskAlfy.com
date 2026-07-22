# 🚀 Finishing Alfy — START HERE

> **You're the finishing engineer.** A hand-rolled Google OAuth + Gmail/Calendar/Tasks/Drive/
> Docs/Sheets REST backend, standing instructions + a cron automation runner, and Stripe
> billing all replaced/extended AskAlfy's original Composio-only scaffold (ported from
> PrymalAI-dashboard — see `docs/prymal-port-reference.md` for the full spec and
> `docs/alfy-handoff.md` for the exact VERIFY list, phase by phase). A fresh Supabase project
> (`askalfy`) is already provisioned and migrated. What's left is a Google Cloud OAuth
> client, Twilio, Anthropic, Stripe, and deploy.

### What's already done (don't rebuild it)
Marketing site, the 3-tab dashboard (Today / Handled / Alfy knows), phone-OTP login, the
`/a` magic-link handler, the DB schema (`supabase/migrations/0001`-`0007_*.sql`, applied to
the live `askalfy` Supabase project), and nine edge functions (`supabase/functions/alfy-*`,
sharing logic via `supabase/functions/_shared/`). It runs on demo data right now with zero
setup.

### Step 1 — Get it running locally (2 min)
```bash
npm install
npm run dev          # open the printed URL → /app shows the dashboard on demo data
```

### Step 2 — Make the remaining accounts (the only thing code can't do)
1. **Supabase** — done: the `askalfy` project exists and is migrated. Copy its URL + anon key.
2. **Twilio** — buy a phone number + register A2P 10DLC.
3. **Google Cloud OAuth client** — a Web application client; register redirect URI
   `${PUBLIC_APP_URL}/auth/google-callback`. Replaces Composio for Gmail/Calendar.
4. **Anthropic** — one API key.
5. **Stripe** — an account, two Products with recurring Prices (Alfy / Alfy Plus), and a
   webhook endpoint registered against `alfy-stripe-webhook`'s deployed URL. See
   `docs/alfy-handoff.md`'s Phase 5 section for the exact events to listen for.

### Step 3 — Wire it up
```bash
cp .env.local.example .env.local        # fill PUBLIC_SUPABASE_URL + PUBLIC_SUPABASE_ANON_KEY
supabase link --project-ref kpybomnunyhazkenyoeb
# set the backend secrets (names listed in .env.local.example):
supabase secrets set SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  ANTHROPIC_API_KEY=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_PHONE_NUMBER=... \
  INTERNAL_FUNCTION_SECRET=...   # must match the secret baked into the live cron.schedule() call, see docs/alfy-handoff.md \
  STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_ALFY=... STRIPE_PRICE_ALFY_PLUS=...
supabase functions deploy alfy-agent alfy-sms-inbound alfy-link alfy-approve alfy-connect alfy-automation-runner alfy-digest alfy-stripe-checkout alfy-stripe-webhook
```
Then:
- **Supabase → Auth → Providers → Phone → Twilio** (so login codes send).
- **Twilio** → point the number's inbound webhook at the `alfy-sms-inbound` function URL.
- Set the real number in `src/lib/config.ts` (`ALFY_PHONE`) and the real
  `GOOGLE_CLIENT_ID` (public, safe to hardcode) once the GCP OAuth client exists.
- Deploy the site (Vercel/Netlify) with the `PUBLIC_` env vars.

### Step 4 — Verify (see `docs/alfy-handoff.md` for the exact calls to confirm)
Google OAuth token exchange + refresh, Gmail send/read + Calendar create/read REST calls,
Twilio signature check, Twilio send.

### Step 5 — Smoke test
Text the number → get a reply + an `Approve:` link → tap it → tap Approve → the action fires
→ a confirmation text arrives. That's the whole loop.

### The one rule you cannot break
**Everything below this line is the design constitution. Match it exactly** — the three
sections, the palette, Fraunces/Inter, the voice, and fern = the approval/trust colour.
Any screen you touch must still look like the rest. Do not add a fourth dashboard tab.

---

# Alfy Design Constitution
Brand: Alfy (askalfy.com). A warm, comfortably competent AI assistant anyone can
text. Tagline: "Just text Alfy." Trust narrative: "Alfy asks first."
Never call it "AI-powered" in copy — it is "an assistant."

## Palette (hardcode these, never substitute)
- Linen (canvas): #FAF5EC | Card surface: #FFFDF8 | Hairline border: #E7DFD0
- Espresso (text): #2E2A24 | Secondary text: #5C554A | Muted: #8A7F6E
- Marigold (primary action ONLY): #E08A2E, text on it #FFF8ED
- Fern (reserved EXCLUSIVELY for approval/trust moments): #4E7D68, tint #EDF3EF
Never introduce purple, neon, gradients, or glassmorphism. Warm neutrals only.

## Type
- Fraunces (weights 500/600) for headlines only — serif, warm, editorial
- Inter (400/500) for everything else: UI, body, buttons, Alfy's speech
- Self-hosted via Fontsource. No layout shift on font load.

## Voice (all UI copy and demo content)
Plain words, contractions, no exclamation marks, no emoji, sentence case.
Alfy reports what it did, then asks. Max 5 lines per Alfy message. Sign-off "— A".
Never "As an AI...". Never guilt, urgency, or hype words (unlock, seamless, supercharge).

## Design laws
1. The product is a phone number — the site's only CTA is "Text Alfy" (+ QR on desktop).
2. Nothing leaves without a yes — approval UI is the hero motif; fern = granted trust.
3. Grandmother-comprehensible: if a screen needs explaining, redesign it.
4. One signature animation per section max. Craft > quantity.
5. Every section must survive this test: would it look at home on an Awwwards site
   while remaining legible to a 65-year-old on a mid-range Android phone?

## Iteration protocol (mandatory)
After building or changing any section: render with Playwright, screenshot,
critique against /references images (spacing rhythm, type contrast, warmth,
hierarchy), list 5 specific deficits, fix, re-screenshot. Minimum 3 rounds
per section before calling it done.
