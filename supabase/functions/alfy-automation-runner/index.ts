// alfy-automation-runner — pg_cron-triggered (see supabase/migrations/0005_automation_cron.sql).
// Finds standing_instructions due per their cadence and re-invokes the agent headlessly with
// a synthetic prompt. Auth is a shared secret (x-runner-key), not a user JWT — there's no
// human session for a scheduled run.
//
// AskAlfy's agent has no self-approve tool at all (unlike PrymalAI's resolve_pending_action) —
// queue_action/send_email/etc. only ever insert a pending approval_queue row, and the only
// path to 'approved' is the dashboard's approveItem(), a separately authenticated user action.
// So there's no tool to strip here for prompt-injection safety; the guard is architectural,
// not per-invocation. The synthetic message still tells the model no human is present, so it
// doesn't ask a question that will never be answered.

import { createClient } from 'npm:@supabase/supabase-js';
import { runAgent } from '../_shared/agent.ts';
import { checkAccess, recordTrialAction } from '../_shared/billing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RUNNER_SECRET = Deno.env.get('INTERNAL_FUNCTION_SECRET')!;

// Slack so an hourly cron tick reliably catches each cadence.
const CADENCE_MS: Record<string, number> = {
	hourly: 55 * 60 * 1000,
	daily: 23 * 60 * 60 * 1000,
	weekly: 6.8 * 24 * 60 * 60 * 1000,
};

Deno.serve(async (req) => {
	if (req.headers.get('x-runner-key') !== RUNNER_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: instructions } = await supa
		.from('standing_instructions')
		.select('id, user_id, goal_text, trigger_config, last_run_at')
		.eq('status', 'active')
		.limit(50);

	const now = Date.now();
	const due = (instructions ?? []).filter((inst) => {
		const cadence = (inst.trigger_config as { cadence?: string } | null)?.cadence ?? 'daily';
		const interval = CADENCE_MS[cadence] ?? CADENCE_MS.daily;
		if (!inst.last_run_at) return true;
		return now - new Date(inst.last_run_at).getTime() >= interval;
	});

	const results = await Promise.allSettled(due.map(async (inst) => {
		// Billing gate applies to scheduled runs too — otherwise a standing instruction on an
		// hourly cadence would be an unmetered way around the trial's action caps. A blocked
		// user's instruction is left with last_run_at untouched (not "due" is recomputed fresh
		// each tick) so it picks back up on the very next tick once they resubscribe, rather
		// than waiting out the full cadence window. No paywall SMS from a cron job — that's
		// only ever sent in response to something the person actually texted.
		const access = await checkAccess(supa, inst.user_id);
		if (!access.allowed) return { id: inst.id, acted: false, skipped: true };

		const today = new Date().toISOString().slice(0, 10);
		const message = `Scheduled check of a standing instruction. This is automation mode — no human is present, so don't ask a question; just look, decide, and act. Today is ${today}.\nThe person's ongoing goal: "${inst.goal_text}"\nLook at the current state with your tools and decide whether anything needs doing today to honor this goal. If yes, act — external actions still go through the approval queue, same as any other turn. If not, reply exactly NO_ACTION.`;

		let reply = '';
		try {
			reply = await runAgent(inst.user_id, message);
		} catch (err) {
			reply = `Error: ${(err as Error).message}`;
		}
		if (access.plan === 'trial') await recordTrialAction(supa, inst.user_id);

		await supa.from('standing_instructions').update({
			last_run_at: new Date().toISOString(),
			last_result: reply.slice(0, 500),
		}).eq('id', inst.id);

		return { id: inst.id, acted: !reply.trim().toUpperCase().startsWith('NO_ACTION') };
	}));

	return new Response(JSON.stringify({ checked: due.length, results }), { headers: { 'Content-Type': 'application/json' } });
});
