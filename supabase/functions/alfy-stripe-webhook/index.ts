// alfy-stripe-webhook — Stripe's webhook, not a user. Auth is the Stripe-Signature header
// (see _shared/billing.ts's verifyStripeSignature), not a Supabase JWT — deployed with
// verify_jwt: false, same pattern as alfy-sms-inbound authenticating Twilio instead.
//
// customer.subscription.* is the single source of truth for users.plan — it fires on
// checkout, renewal, upgrade/downgrade via the Billing Portal, and cancellation alike, and
// always carries the current status + price. checkout.session.completed only exists here to
// persist stripe_subscription_id a little earlier than the subscription event would.

import { createClient } from 'npm:@supabase/supabase-js';
import { STRIPE_PRICE_ALFY_PLUS, verifyStripeSignature } from '../_shared/billing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function planForSubscription(status: string, priceId: string | undefined): string {
	if (status === 'active' || status === 'trialing') return priceId === STRIPE_PRICE_ALFY_PLUS ? 'plus' : 'active';
	if (status === 'past_due' || status === 'unpaid' || status === 'incomplete_expired') return 'past_due';
	return 'canceled';
}

Deno.serve(async (req) => {
	const rawBody = await req.text();
	const valid = await verifyStripeSignature(rawBody, req.headers.get('stripe-signature'));
	if (!valid) return new Response('invalid signature', { status: 403 });

	const event = JSON.parse(rawBody);
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

	switch (event.type) {
		case 'checkout.session.completed': {
			const session = event.data.object;
			if (session.customer && session.subscription) {
				await supa.from('users').update({ stripe_subscription_id: session.subscription }).eq('stripe_customer_id', session.customer);
			}
			break;
		}
		case 'customer.subscription.created':
		case 'customer.subscription.updated': {
			const sub = event.data.object;
			const priceId = sub.items?.data?.[0]?.price?.id as string | undefined;
			await supa.from('users').update({
				plan: planForSubscription(sub.status, priceId),
				stripe_subscription_id: sub.id,
			}).eq('stripe_customer_id', sub.customer);
			break;
		}
		case 'customer.subscription.deleted': {
			const sub = event.data.object;
			await supa.from('users').update({ plan: 'canceled' }).eq('stripe_customer_id', sub.customer);
			break;
		}
	}

	return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } });
});
