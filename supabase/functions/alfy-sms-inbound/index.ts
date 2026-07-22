// alfy-sms-inbound — Twilio Messaging webhook. The front door.
// Fast + queue-shaped: verify, dedupe, route, run the agent, text back. At scale, swap the
// inline runAgent for an enqueue + worker (see docs/alfy-handoff.md) — the seam is right here.

import { createClient } from 'npm:@supabase/supabase-js';
import { runAgent } from '../_shared/agent.ts';
import {
	checkAccess,
	getOrCreateStripeCustomer,
	paywallCopy,
	recordTrialAction,
	STRIPE_PRICE_ALFY,
	stripeCreateCheckoutSession,
} from '../_shared/billing.ts';
import { sendSms, TWILIO_FROM_NUMBER, validateTwilioSignature } from '../_shared/twilio.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('PUBLIC_APP_URL') ?? 'https://askalfy.com';

function randomToken() {
	return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

// Every account carries a synthetic auth email derived from its number, so the phone-first
// user can still mint email-style magic links (see alfy-link). Never actually emailed.
function syntheticEmail(phoneE164: string) {
	return `${phoneE164.replace(/\D/g, '')}@sms.askalfy.com`;
}

Deno.serve(async (req) => {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const form = await req.formData();
	const params: Record<string, string> = {};
	for (const [key, value] of form.entries()) params[key] = String(value);

	const validSignature = await validateTwilioSignature(req, params);
	if (!validSignature) return new Response('invalid signature', { status: 403 });

	const from = params['From'] ?? '';
	const body = (params['Body'] ?? '').trim();
	const sid = params['MessageSid'] ?? '';

	// Carrier-mandated keywords — handle before anything else.
	const kw = body.toUpperCase();
	if (kw === 'STOP' || kw === 'UNSUBSCRIBE') {
		await supa.from('user_phones').update({ consent: 'opted_out' }).eq('phone_e164', from);
		return new Response(null, { status: 204 });
	}
	if (kw === 'HELP') {
		await sendSms(from, 'Alfy here. Text anything you want handled. Reply STOP to opt out. — A');
		return new Response(null, { status: 204 });
	}

	// Map number → account. Match the NUMBER, never the device.
	const { data: phone } = await supa.from('user_phones').select('user_id, consent').eq('phone_e164', from).maybeSingle();

	if (!phone) {
		// Unknown number. "YES/START" = consent → create the account; else prompt.
		if (['YES', 'START', 'Y'].includes(kw)) {
			const now = new Date().toISOString();
			const { data: created } = await supa.auth.admin.createUser({
				phone: from,
				email: syntheticEmail(from),
				phone_confirm: true,
				email_confirm: true,
			});
			if (created?.user) {
				const { data: u } = await supa.from('users').insert({ auth_user_id: created.user.id }).select('id').single();
				if (u) await supa.from('user_phones').insert({ user_id: u.id, phone_e164: from, is_primary: true, consent: 'opted_in', consent_at: now, verified_at: now });
			}
			await sendSms(from, "You're set up. Text me anything you want handled — I'll draft it and ask before anything sends. — A");
			return new Response(null, { status: 204 });
		}
		await sendSms(from, "Hi, I'm Alfy. Want me to set you up? Reply YES and I'll get you started. — A");
		return new Response(null, { status: 204 });
	}

	// Dedupe: unique twilio_sid means a retry just no-ops here.
	const { error: dupe } = await supa.from('messages').insert({ user_id: phone.user_id, from_phone: from, direction: 'inbound', body, twilio_sid: sid });
	if (dupe) return new Response(null, { status: 200 }); // already processed

	// Billing gate — trial cap hit, trial expired, or no active subscription. Nothing runs;
	// send the one paywall text with a Stripe Checkout link instead of touching a tool.
	const access = await checkAccess(supa, phone.user_id);
	if (!access.allowed) {
		const { data: acct } = await supa.from('users').select('stripe_customer_id, recovery_email').eq('id', phone.user_id).single();
		const customerId = await getOrCreateStripeCustomer(supa, phone.user_id, acct?.recovery_email ?? syntheticEmail(from), acct?.stripe_customer_id);
		const checkoutUrl = await stripeCreateCheckoutSession({
			customerId,
			priceId: STRIPE_PRICE_ALFY,
			successUrl: `${APP_URL}/app?upgraded=1`,
			cancelUrl: `${APP_URL}/app`,
		});
		const text = `${paywallCopy(access.reason)}\n${checkoutUrl}`;
		await supa.from('messages').insert({ user_id: phone.user_id, from_phone: TWILIO_FROM_NUMBER, direction: 'outbound', body: text });
		await sendSms(from, text);
		return new Response(null, { status: 200 });
	}

	// Run the agent (inline now; enqueue at scale).
	const reply = await runAgent(phone.user_id, body);
	if (access.plan === 'trial') await recordTrialAction(supa, phone.user_id);

	// If the turn queued anything, mint a one-time approval link and append it.
	const { data: pending } = await supa
		.from('approval_queue').select('id').eq('user_id', phone.user_id).eq('status', 'pending')
		.order('created_at', { ascending: false }).limit(1);

	let text = reply;
	if (pending && pending.length > 0) {
		const token = randomToken();
		await supa.from('access_links').insert({
			user_id: phone.user_id, approval_id: pending[0].id, token,
			expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
		});
		text += `\nApprove: ${APP_URL}/a?t=${token}`;
	}

	await supa.from('messages').insert({ user_id: phone.user_id, from_phone: TWILIO_FROM_NUMBER, direction: 'outbound', body: text });
	await sendSms(from, text);
	return new Response(null, { status: 200 });
});
