// alfy-approve — executes an approved action. Called after the person taps Approve.
// This is one of two callers of _shared/executors.ts's executeAction (the other is the
// standing-permission auto-execute path in _shared/agent.ts's queue()) — the human-tap path.
// Unknown action_type marks the row failed instead of hard-erroring, so a queue_action the
// model invented without a matching executor fails gracefully.

import { createClient } from 'npm:@supabase/supabase-js';
import { executeAction } from '../_shared/executors.ts';
import { sendSms, TWILIO_FROM_NUMBER } from '../_shared/twilio.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
	const { approval_id } = await req.json();
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

	const { data: row } = await supa
		.from('approval_queue')
		.select('id, user_id, action_type, action_payload, draft_content, status, summary')
		.eq('id', approval_id)
		.single();

	if (!row || row.status !== 'approved') return new Response(JSON.stringify({ error: 'not approvable' }), { status: 409 });

	// The person's phone for the confirmation text.
	const { data: phone } = await supa.from('user_phones').select('phone_e164').eq('user_id', row.user_id).eq('is_primary', true).single();

	try {
		const { confirmationText } = await executeAction(
			supa,
			row.user_id,
			row.action_type,
			row.action_payload as Record<string, unknown>,
			row.draft_content,
		);

		await supa.from('approval_queue').update({
			status: 'executed',
			executed_at: new Date().toISOString(),
			undo_until: new Date(Date.now() + 10 * 60_000).toISOString(),
		}).eq('id', row.id);

		if (phone) {
			const confirmation = confirmationText ?? `Done — ${row.summary}. — A`;
			await sendSms(phone.phone_e164, confirmation);
			await supa.from('messages').insert({ user_id: row.user_id, from_phone: TWILIO_FROM_NUMBER, direction: 'outbound', body: confirmation });
		}
		return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
	} catch (err) {
		await supa.from('approval_queue').update({ status: 'failed' }).eq('id', row.id);
		return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
	}
});
