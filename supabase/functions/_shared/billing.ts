// Plan gating + hand-rolled Stripe REST calls. Tier shape is Pally-style (pally.com: Free /
// Pro / Max, gated by usage ceiling) rather than PrymalAI's per-Google-service tiers — every
// plan gets every tool, so there's no feature matrix a person has to decode before texting
// Alfy. Trial mechanic (75 total / 20-per-day caps) is ported as-is from PrymalAI, proven.

import type { createClient } from 'npm:@supabase/supabase-js';

const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

// Stripe Price ids for the two paid plans — created once in the Stripe dashboard (can't be
// minted from here without live Stripe credentials), then set as edge-function secrets.
export const STRIPE_PRICE_ALFY = Deno.env.get('STRIPE_PRICE_ALFY')!;
export const STRIPE_PRICE_ALFY_PLUS = Deno.env.get('STRIPE_PRICE_ALFY_PLUS')!;

const STRIPE_BASE = 'https://api.stripe.com/v1';

type SupabaseClient = ReturnType<typeof createClient>;

const TRIAL_ACTION_CAP = 75;
const TRIAL_DAILY_CAP = 20;

async function stripeFetch(path: string, body: Record<string, string>) {
	const res = await fetch(`${STRIPE_BASE}${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams(body),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(`Stripe ${path} failed: ${data.error?.message ?? JSON.stringify(data)}`);
	return data;
}

// One Stripe customer per Alfy account, created lazily on first checkout and cached on
// users.stripe_customer_id so later checkouts/portal sessions reuse it.
export async function getOrCreateStripeCustomer(
	supa: SupabaseClient,
	userId: string,
	email: string,
	existingCustomerId?: string | null,
): Promise<string> {
	if (existingCustomerId) return existingCustomerId;
	const customer = await stripeFetch('/customers', { email, 'metadata[user_id]': userId });
	await supa.from('users').update({ stripe_customer_id: customer.id }).eq('id', userId);
	return customer.id as string;
}

export async function stripeCreateCheckoutSession(args: {
	customerId: string;
	priceId: string;
	successUrl: string;
	cancelUrl: string;
}): Promise<string> {
	const session = await stripeFetch('/checkout/sessions', {
		customer: args.customerId,
		mode: 'subscription',
		'line_items[0][price]': args.priceId,
		'line_items[0][quantity]': '1',
		success_url: args.successUrl,
		cancel_url: args.cancelUrl,
	});
	return session.url as string;
}

// Stripe's own hosted "manage my subscription" page — covers cancel/upgrade/payment-method
// update without Alfy building any of that UI itself.
export async function stripeCreatePortalSession(args: { customerId: string; returnUrl: string }): Promise<string> {
	const session = await stripeFetch('/billing_portal/sessions', {
		customer: args.customerId,
		return_url: args.returnUrl,
	});
	return session.url as string;
}

// Stripe: signature header is "t=<timestamp>,v1=<hex hmac-sha256>" over "<timestamp>.<rawBody>".
// Same shape as the Twilio signature check in _shared/twilio.ts, different algorithm.
export async function verifyStripeSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
	if (!signatureHeader || !STRIPE_WEBHOOK_SECRET) return false;
	const parts = Object.fromEntries(signatureHeader.split(',').map((p) => p.split('=') as [string, string]));
	if (!parts.t || !parts.v1) return false;

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(STRIPE_WEBHOOK_SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${rawBody}`));
	const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
	return expected === parts.v1;
}

export type PlanAccess =
	| { allowed: true; plan: 'trial' | 'active' | 'plus' }
	| { allowed: false; reason: 'trial_ended' | 'trial_capped' | 'trial_daily_capped' | 'no_subscription' };

// The gate every agent turn passes through before touching a single tool. 'active'/'plus'
// are uncapped; 'trial' enforces the hard 75-total / soft 20-per-day caps; anything else
// (past_due, canceled, no row) is blocked outright.
export async function checkAccess(supa: SupabaseClient, userId: string): Promise<PlanAccess> {
	const { data: user } = await supa
		.from('users')
		.select('plan, trial_ends_at, trial_actions_used, trial_daily_actions, trial_daily_reset_date')
		.eq('id', userId)
		.single();
	if (!user) return { allowed: false, reason: 'no_subscription' };

	if (user.plan === 'active' || user.plan === 'plus') return { allowed: true, plan: user.plan };
	if (user.plan !== 'trial') return { allowed: false, reason: 'no_subscription' };

	if (new Date(user.trial_ends_at as string).getTime() <= Date.now()) return { allowed: false, reason: 'trial_ended' };
	if ((user.trial_actions_used as number) >= TRIAL_ACTION_CAP) return { allowed: false, reason: 'trial_capped' };

	const today = new Date().toISOString().slice(0, 10);
	const todaysCount = user.trial_daily_reset_date === today ? (user.trial_daily_actions as number) : 0;
	if (todaysCount >= TRIAL_DAILY_CAP) return { allowed: false, reason: 'trial_daily_capped' };

	return { allowed: true, plan: 'trial' };
}

// Call once per turn, only while plan === 'trial' and the turn was allowed to run.
export async function recordTrialAction(supa: SupabaseClient, userId: string): Promise<void> {
	await supa.rpc('increment_trial_action', { p_user_id: userId });
}

// Alfy's voice for the one message that isn't "here's what I did" — plain, no hype, no
// exclamation marks, sign-off "— A". Caller appends the checkout link as its own line.
export function paywallCopy(reason: Exclude<PlanAccess, { allowed: true }>['reason']): string {
	switch (reason) {
		case 'trial_ended':
			return "Your free trial's up. Pick a plan and I'll pick up right where we left off.";
		case 'trial_capped':
			return "You've used up your trial. Ready to keep going?";
		case 'trial_daily_capped':
			return "You've hit today's trial limit — back tomorrow, or upgrade now if you'd rather not wait.";
		case 'no_subscription':
			return "Your plan's on hold, so I can't act on this yet. Here's the link to sort it out.";
	}
}
