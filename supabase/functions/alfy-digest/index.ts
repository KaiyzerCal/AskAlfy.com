// alfy-digest — pg_cron-triggered hourly (see docs/alfy-handoff.md for the cron.schedule()
// SQL), same shared-secret pattern as alfy-automation-runner. The other half of the closed
// loop: a morning brief (what needs a yes, what's being watched, what's on the calendar
// today) and an evening debrief (what got handled, what's still waiting). Both are built
// deterministically from the DB, not another Claude call — a fixed-shape summary doesn't
// need a model, and skipping the call keeps this cheap to run for every user every hour.
//
// Windows are per-user local time (from users.timezone), checked every hour rather than
// scheduled per-timezone, so one cron job covers every timezone without per-user schedules.
// last_brief_sent_date/last_debrief_sent_date (the person's own local date) dedupe across
// the ~3 hourly ticks that fall inside each window.

import { createClient } from 'npm:@supabase/supabase-js';
import { checkAccess } from '../_shared/billing.ts';
import { calendarListEvents, getFreshToken } from '../_shared/google.ts';
import { sendSms, TWILIO_FROM_NUMBER } from '../_shared/twilio.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RUNNER_SECRET = Deno.env.get('INTERNAL_FUNCTION_SECRET')!;

const MORNING_WINDOW = [7, 10] as const; // 7:00–9:59 local
const EVENING_WINDOW = [18, 21] as const; // 18:00–20:59 local

function getLocalParts(date: Date, timeZone: string) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
	const parts: Record<string, string> = {};
	for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour) % 24, // ICU sometimes renders midnight as "24"
		minute: Number(parts.minute),
	};
}

// Standard trick for a timezone-correct instant without a library: render the intended wall
// clock as if it were UTC, see how that instant actually reads in the target zone, and
// correct by the drift.
function zonedTimeToUtc(y: number, m: number, d: number, h: number, mi: number, timeZone: string): Date {
	const asUTC = new Date(Date.UTC(y, m - 1, d, h, mi, 0));
	const inTz = new Date(asUTC.toLocaleString('en-US', { timeZone }));
	return new Date(asUTC.getTime() + (asUTC.getTime() - inTz.getTime()));
}

function startOfLocalDay(date: Date, timeZone: string): Date {
	const { year, month, day } = getLocalParts(date, timeZone);
	return zonedTimeToUtc(year, month, day, 0, 0, timeZone);
}

function localDateString(date: Date, timeZone: string): string {
	const { year, month, day } = getLocalParts(date, timeZone);
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Respects the person's own quiet-hours setting (default 21:00–07:00) even though the
// morning/evening windows above are already chosen to sit outside the default range — a
// custom quiet_hours_end past 10am, say, should still suppress the morning brief.
function isQuietHour(hour: number, start: number, end: number): boolean {
	return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

async function buildMorningBrief(supa: ReturnType<typeof createClient>, userId: string, timeZone: string, now: Date): Promise<string> {
	const dayStart = startOfLocalDay(now, timeZone);
	const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

	const [pendingCountRes, pendingRowsRes, instructionsRes] = await Promise.all([
		supa.from('approval_queue').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'pending'),
		supa.from('approval_queue').select('summary').eq('user_id', userId).eq('status', 'pending').order('created_at', { ascending: false }).limit(2),
		supa.from('standing_instructions').select('goal_text').eq('user_id', userId).eq('status', 'active').limit(3),
	]);
	const pendingCount = pendingCountRes.count ?? 0;
	const pendingRows = pendingRowsRes.data ?? [];
	const instructions = instructionsRes.data ?? [];

	let eventsLine = '';
	const token = await getFreshToken(supa, userId, 'calendar');
	if (token) {
		try {
			const events = await calendarListEvents(token, { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), maxResults: 3 });
			if (events.length > 0) {
				const first = events[0] as { summary?: string; start?: { dateTime?: string } };
				const time = first.start?.dateTime
					? new Date(first.start.dateTime).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
					: 'today';
				eventsLine = ` ${events.length} on your calendar today, starting with ${first.summary ?? 'something'} at ${time}.`;
			}
		} catch {
			// Best-effort — a brief still goes out even if the calendar read fails.
		}
	}

	const openingLine = pendingCount === 0
		? "Morning. Nothing needs your yes right now."
		: `Morning. ${pendingCount === 1 ? 'One thing needs' : `${pendingCount} things need`} your yes: ${pendingRows.map((r) => r.summary).join(', ')}${pendingCount > pendingRows.length ? ', and more' : ''}.`;

	const watchingLine = instructions.length > 0 ? ` Still watching: ${instructions.map((i) => i.goal_text).join(', ')}.` : '';

	return `${openingLine}${watchingLine}${eventsLine}\n— A`;
}

async function buildEveningDebrief(supa: ReturnType<typeof createClient>, userId: string, timeZone: string, now: Date): Promise<string> {
	const dayStart = startOfLocalDay(now, timeZone);

	const [executedRes, pendingRes] = await Promise.all([
		supa.from('approval_queue').select('summary').eq('user_id', userId).eq('status', 'executed')
			.gte('executed_at', dayStart.toISOString()).order('executed_at', { ascending: false }).limit(5),
		supa.from('approval_queue').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'pending'),
	]);
	const executedToday = executedRes.data ?? [];
	const stillPending = pendingRes.count ?? 0;

	if (executedToday.length === 0 && stillPending === 0) return 'Quiet day — nothing came up. — A';

	let line = executedToday.length > 0
		? `Handled ${executedToday.length} thing${executedToday.length === 1 ? '' : 's'} today: ${executedToday.slice(0, 3).map((r) => r.summary).join(', ')}${executedToday.length > 3 ? ', and more' : ''}.`
		: 'Nothing to report done today.';

	if (stillPending > 0) line += ` ${stillPending} still waiting on your yes.`;

	return `${line}\n— A`;
}

Deno.serve(async (req) => {
	if (req.headers.get('x-runner-key') !== RUNNER_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}

	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const { data: users } = await supa
		.from('users')
		.select('id, timezone, quiet_hours_start, quiet_hours_end, last_brief_sent_date, last_debrief_sent_date');

	const now = new Date();
	const results: { user_id: string; sent: 'brief' | 'debrief' }[] = [];

	for (const user of users ?? []) {
		const timeZone = user.timezone || 'America/New_York';
		const { hour } = getLocalParts(now, timeZone);
		const today = localDateString(now, timeZone);
		const quiet = isQuietHour(hour, user.quiet_hours_start ?? 21, user.quiet_hours_end ?? 7);

		const wantsBrief = !quiet && hour >= MORNING_WINDOW[0] && hour < MORNING_WINDOW[1] && user.last_brief_sent_date !== today;
		const wantsDebrief = !quiet && hour >= EVENING_WINDOW[0] && hour < EVENING_WINDOW[1] && user.last_debrief_sent_date !== today;
		if (!wantsBrief && !wantsDebrief) continue;

		const { data: phone } = await supa
			.from('user_phones').select('phone_e164').eq('user_id', user.id).eq('is_primary', true).eq('consent', 'opted_in').maybeSingle();
		if (!phone) continue;

		// Same billing gate as every other agent-adjacent surface — no proactive text to a
		// blocked account.
		const access = await checkAccess(supa, user.id);
		if (!access.allowed) continue;

		if (wantsBrief) {
			const text = await buildMorningBrief(supa, user.id, timeZone, now);
			await sendSms(phone.phone_e164, text);
			await supa.from('messages').insert({ user_id: user.id, from_phone: TWILIO_FROM_NUMBER, direction: 'outbound', body: text });
			await supa.from('users').update({ last_brief_sent_date: today }).eq('id', user.id);
			results.push({ user_id: user.id, sent: 'brief' });
		}
		if (wantsDebrief) {
			const text = await buildEveningDebrief(supa, user.id, timeZone, now);
			await sendSms(phone.phone_e164, text);
			await supa.from('messages').insert({ user_id: user.id, from_phone: TWILIO_FROM_NUMBER, direction: 'outbound', body: text });
			await supa.from('users').update({ last_debrief_sent_date: today }).eq('id', user.id);
			results.push({ user_id: user.id, sent: 'debrief' });
		}
	}

	return new Response(JSON.stringify({ checked: (users ?? []).length, results }), { headers: { 'Content-Type': 'application/json' } });
});
