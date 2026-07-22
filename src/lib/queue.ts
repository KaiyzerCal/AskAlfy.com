import { supabase } from './supabase';
import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES } from './config';

// Data layer for the dashboard's three tabs. Reads Supabase when configured;
// falls back to demo data so a fresh fork renders with zero setup.
// ponytail: demo constants ARE the fallback — one source, no duplicate fixtures.

export interface QueueItem {
	id: string | number;
	kind: string;
	summary: string;
	draft: string;
}

export interface HandledItem {
	id: string | number;
	kind: string;
	what: string;
	when: string;
	undo: boolean;
	standing: boolean; // true = a standing okay, false = you approved it
}

export type Range = 'week' | 'lastweek' | 'all';

export const DEMO_QUEUE: QueueItem[] = [
	{ id: 1, kind: 'Email', summary: 'Reply to Dana about Thursday', draft: "Thursday works — I'll bring the numbers from last quarter. See you at 2. — Jordan" },
	{ id: 2, kind: 'Calendar', summary: 'Book the dentist, Tuesday 9:00', draft: 'Dr. Okafor has Tuesday 9:00 open. It fits before your 10:30 call.' },
	{ id: 3, kind: 'Order', summary: "Mom's birthday flowers, $34", draft: 'Lily bouquet from the florist she used last year. Arrives Friday, card included.' },
];

export const DEMO_HANDLED: HandledItem[] = [
	{ id: 101, kind: 'Bill', what: 'Paid the wifi bill', when: 'a standing yes you gave Jan 12', undo: false, standing: true },
	{ id: 102, kind: 'Calendar', what: 'Moved lunch with Priya to Friday', when: 'you approved, yesterday', undo: true, standing: false },
	{ id: 103, kind: 'Order', what: 'Renewed the prescription', when: 'you approved, Tuesday', undo: false, standing: false },
];

export async function loadToday(): Promise<QueueItem[]> {
	if (!supabase) return DEMO_QUEUE;
	const { data } = await supabase
		.from('approval_queue')
		.select('id, kind, summary, draft_content')
		.eq('status', 'pending')
		.order('created_at', { ascending: false });
	return (data ?? []).map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, draft: r.draft_content ?? '' }));
}

export async function loadHandled(range: Range): Promise<HandledItem[]> {
	if (!supabase) return DEMO_HANDLED;
	let q = supabase
		.from('approval_queue')
		.select('id, kind, summary, standing_permission_id, decided_at, undo_until')
		.in('status', ['approved', 'executed'])
		.order('decided_at', { ascending: false });

	const now = Date.now();
	if (range === 'week') q = q.gte('decided_at', new Date(now - 7 * 864e5).toISOString());
	else if (range === 'lastweek')
		q = q.gte('decided_at', new Date(now - 14 * 864e5).toISOString()).lt('decided_at', new Date(now - 7 * 864e5).toISOString());

	const { data } = await q;
	return (data ?? []).map((r) => ({
		id: r.id,
		kind: r.kind,
		what: r.summary,
		when: r.standing_permission_id ? 'a standing okay' : 'you approved',
		undo: !!r.undo_until && new Date(r.undo_until).getTime() > now,
		standing: !!r.standing_permission_id,
	}));
}

// Optimistic dashboard writes. No-op offline; the worker executes after the flip.
export async function approveItem(id: string | number): Promise<void> {
	if (!supabase) return;
	await supabase.from('approval_queue').update({ status: 'approved', decided_at: new Date().toISOString() }).eq('id', id);
	// Flip first, then fire execution (alfy-approve replays the action via Composio + confirms by SMS).
	await supabase.functions.invoke('alfy-approve', { body: { approval_id: id } });
}

export async function skipItem(id: string | number): Promise<void> {
	if (!supabase) return;
	await supabase.from('approval_queue').update({ status: 'skipped', decided_at: new Date().toISOString() }).eq('id', id);
}

// Builds the Google consent-screen URL client-side (GOOGLE_CLIENT_ID is public) and
// redirects straight to it, asking for every scope Alfy's tools use in one screen. The
// callback page (/auth/google-callback) hands the returned code to alfy-connect, which
// does the actual token exchange.
export function connectGoogle(): void {
	const redirectUri = `${window.location.origin}/auth/google-callback`;
	const params = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: GOOGLE_SCOPES.join(' '),
		access_type: 'offline',
		prompt: 'consent',
		state: 'google',
	});
	window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface PersonItem {
	id: string | number;
	name: string;
	note: string;
}

export interface TrustItem {
	id: string | number;
	line: string;
	since: string;
}

export const DEMO_PEOPLE: PersonItem[] = [
	{ id: 1, name: 'Sam', note: 'Your brother. Prefers texts. Owes you $40.' },
	{ id: 2, name: 'Dana', note: 'Coworker. Prefers email, mornings only.' },
	{ id: 3, name: 'Mom', note: 'Birthday June 14. Likes lilies, not roses.' },
];

export const DEMO_TRUST: TrustItem[] = [
	{ id: 1, line: 'Sends calendar replies without asking', since: 'you granted this Jan 12' },
	{ id: 2, line: 'Pays the wifi bill each month', since: 'you granted this Feb 3' },
];

export async function loadPeople(): Promise<PersonItem[]> {
	if (!supabase) return DEMO_PEOPLE;
	const { data } = await supabase.from('people').select('id, name, context_summary').order('updated_at', { ascending: false });
	return (data ?? []).map((r) => ({ id: r.id, name: r.name, note: r.context_summary ?? '' }));
}

function grantedLabel(iso: string): string {
	const d = new Date(iso);
	return `you granted this ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export async function loadTrust(): Promise<TrustItem[]> {
	if (!supabase) return DEMO_TRUST;
	const { data } = await supabase
		.from('standing_permissions')
		.select('id, description, granted_at')
		.is('revoked_at', null)
		.order('granted_at', { ascending: false });
	return (data ?? []).map((r) => ({ id: r.id, line: r.description, since: grantedLabel(r.granted_at) }));
}

export async function revokeTrust(id: string | number): Promise<void> {
	if (!supabase) return;
	await supabase.from('standing_permissions').update({ revoked_at: new Date().toISOString() }).eq('id', id);
}

export interface Breakdown {
	total: number;
	byKind: [string, number][];
	approved: number;
	standing: number;
	hoursSaved: number;
}

export interface BillingStatus {
	plan: 'trial' | 'active' | 'plus' | 'past_due' | 'canceled';
	trialEndsAt: string | null;
}

// null in demo mode (no Supabase configured) or if the row can't be read — callers fall
// back to the same static "manage" placeholder the Settings panel always showed pre-Stripe.
export async function loadBilling(): Promise<BillingStatus | null> {
	if (!supabase) return null;
	const { data } = await supabase.from('users').select('plan, trial_ends_at').single();
	if (!data) return null;
	return { plan: data.plan, trialEndsAt: data.trial_ends_at };
}

// One button, two jobs: alfy-stripe-checkout decides server-side whether this account needs
// a Checkout Session (trial/past_due/canceled) or a Billing Portal session (already
// active/plus) — the dashboard doesn't need to know which before redirecting.
export async function startCheckout(plan: 'active' | 'plus' = 'active'): Promise<void> {
	if (!supabase) return;
	const { data } = await supabase.functions.invoke('alfy-stripe-checkout', { body: { plan } });
	if (data?.url) window.location.href = data.url;
}

export function breakdown(items: HandledItem[]): Breakdown {
	const counts = new Map<string, number>();
	for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
	return {
		total: items.length,
		byKind: [...counts.entries()].sort((a, b) => b[1] - a[1]),
		approved: items.filter((i) => !i.standing).length,
		standing: items.filter((i) => i.standing).length,
		// ponytail: ~12 min saved per handled item — a display heuristic, not a tracked metric.
		hoursSaved: Math.max(0.5, Math.round((items.length * 0.2) * 2) / 2),
	};
}
