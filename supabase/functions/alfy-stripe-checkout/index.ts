// alfy-stripe-checkout — one button in Settings → Billing calls this. If the person has no
// active subscription it mints a Stripe Checkout Session for the requested plan; if they're
// already subscribed it mints a Billing Portal session instead, so the same button reads as
// "Upgrade" or "Manage billing" depending on state without the dashboard needing to build
// any subscription-management UI of its own.

import { createClient } from 'npm:@supabase/supabase-js';
import {
	getOrCreateStripeCustomer,
	STRIPE_PRICE_ALFY,
	STRIPE_PRICE_ALFY_PLUS,
	stripeCreateCheckoutSession,
	stripeCreatePortalSession,
} from '../_shared/billing.ts';
import { corsHeaders } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const APP_URL = Deno.env.get('PUBLIC_APP_URL') ?? 'https://askalfy.com';

Deno.serve(async (req) => {
	const cors = corsHeaders(req);
	if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

	const auth = req.headers.get('Authorization');
	if (!auth) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

	const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
	const { data: { user } } = await anon.auth.getUser(auth.replace('Bearer ', ''));
	if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: acct } = await supa
		.from('users')
		.select('id, plan, stripe_customer_id, recovery_email')
		.eq('auth_user_id', user.id)
		.single();
	if (!acct) return new Response(JSON.stringify({ error: 'no account' }), { status: 404, headers: cors });

	const { plan } = await req.json().catch(() => ({ plan: 'active' }));
	const priceId = plan === 'plus' ? STRIPE_PRICE_ALFY_PLUS : STRIPE_PRICE_ALFY;

	const email = acct.recovery_email ?? user.email ?? undefined;
	const customerId = await getOrCreateStripeCustomer(supa, acct.id, email ?? `${acct.id}@sms.askalfy.com`, acct.stripe_customer_id);

	try {
		if (acct.plan === 'active' || acct.plan === 'plus') {
			const url = await stripeCreatePortalSession({ customerId, returnUrl: `${APP_URL}/app` });
			return new Response(JSON.stringify({ url, mode: 'portal' }), { headers: { 'Content-Type': 'application/json', ...cors } });
		}

		const url = await stripeCreateCheckoutSession({
			customerId,
			priceId,
			successUrl: `${APP_URL}/app?upgraded=1`,
			cancelUrl: `${APP_URL}/app`,
		});
		return new Response(JSON.stringify({ url, mode: 'checkout' }), { headers: { 'Content-Type': 'application/json', ...cors } });
	} catch (err) {
		return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: cors });
	}
});
