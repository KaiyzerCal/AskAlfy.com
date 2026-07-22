// alfy-approve — executes an approved action. Called after the person taps Approve.
// This is the ONLY place an outbound action actually fires, and only for status='approved'.
// Reads action_payload the agent stashed, replays it via the real Google API, texts a
// confirmation. Unknown action_type marks the row failed instead of hard-erroring, so a
// queue_action the model invented without a matching executor fails gracefully.

import { createClient } from 'npm:@supabase/supabase-js';
import {
	calendarCreateEvent,
	calendarDeleteEvent,
	calendarScheduleMeet,
	calendarUpdateEvent,
	docsCreate,
	docsUpdate,
	driveCreateFolder,
	driveDeleteFile,
	driveMoveFile,
	driveRenameFile,
	driveSetPermissions,
	getFreshToken,
	gmailApplyLabel,
	gmailArchive,
	gmailCreateDraft,
	gmailCreateFilter,
	gmailCreateLabel,
	gmailMarkRead,
	gmailMarkUnread,
	gmailRemoveLabel,
	gmailSend,
	gmailSetAutoReply,
	gmailTrash,
	sheetsCreate,
	sheetsUpdate,
	tasksComplete,
	tasksCreate,
	tasksUpdate,
} from '../_shared/google.ts';
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

	// Overridden for actions where "Done" would overstate what happened (e.g. schedule_send,
	// which Gmail can't actually schedule — it becomes a draft, not a sent message).
	let confirmationText: string | null = null;

	try {
		switch (row.action_type) {
			case 'send_email': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				const payload = row.action_payload as { to: string; cc?: string | null; bcc?: string | null; subject: string };
				await gmailSend(token, { ...payload, body: row.draft_content ?? '' });
				break;
			}
			case 'create_event': {
				const token = await getFreshToken(supa, row.user_id, 'calendar');
				if (!token) throw new Error('Calendar is not connected.');
				await calendarCreateEvent(token, row.action_payload as Parameters<typeof calendarCreateEvent>[1]);
				break;
			}
			case 'create_label': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				await gmailCreateLabel(token, row.action_payload as { name: string });
				break;
			}
			case 'apply_label': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				const payload = row.action_payload as { threadIds: string[]; labelName: string };
				await gmailApplyLabel(token, payload.threadIds, payload.labelName);
				break;
			}
			case 'remove_label': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				const payload = row.action_payload as { threadIds: string[]; labelName: string };
				await gmailRemoveLabel(token, payload.threadIds, payload.labelName);
				break;
			}
			case 'archive_email': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				await gmailArchive(token, (row.action_payload as { threadIds: string[] }).threadIds);
				break;
			}
			case 'mark_as_read': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				await gmailMarkRead(token, (row.action_payload as { threadIds: string[] }).threadIds);
				break;
			}
			case 'mark_as_unread': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				await gmailMarkUnread(token, (row.action_payload as { threadIds: string[] }).threadIds);
				break;
			}
			case 'delete_email': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				await gmailTrash(token, (row.action_payload as { threadIds: string[] }).threadIds);
				break;
			}
			case 'create_filter': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				await gmailCreateFilter(token, row.action_payload as Parameters<typeof gmailCreateFilter>[1]);
				break;
			}
			case 'set_auto_reply': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				const payload = row.action_payload as { subject?: string; startTime?: string; endTime?: string; restrictToContacts?: boolean; restrictToDomain?: boolean };
				await gmailSetAutoReply(token, { ...payload, message: row.draft_content ?? '' });
				break;
			}
			case 'schedule_send': {
				const token = await getFreshToken(supa, row.user_id, 'gmail');
				if (!token) throw new Error('Gmail is not connected.');
				const payload = row.action_payload as { to: string; cc?: string | null; bcc?: string | null; subject: string; sendAt: string };
				await gmailCreateDraft(token, { to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, body: row.draft_content ?? '' });
				confirmationText = `Saved as a draft — Gmail doesn't support scheduled send yet, so finish it there when you're ready. — A`;
				break;
			}
			case 'update_event': {
				const token = await getFreshToken(supa, row.user_id, 'calendar');
				if (!token) throw new Error('Calendar is not connected.');
				const payload = row.action_payload as { eventId: string };
				await calendarUpdateEvent(token, payload.eventId, row.action_payload as Parameters<typeof calendarUpdateEvent>[2]);
				break;
			}
			case 'delete_event': {
				const token = await getFreshToken(supa, row.user_id, 'calendar');
				if (!token) throw new Error('Calendar is not connected.');
				await calendarDeleteEvent(token, (row.action_payload as { eventId: string }).eventId);
				break;
			}
			case 'schedule_meet': {
				const token = await getFreshToken(supa, row.user_id, 'calendar');
				if (!token) throw new Error('Calendar is not connected.');
				await calendarScheduleMeet(token, row.action_payload as Parameters<typeof calendarScheduleMeet>[1]);
				break;
			}
			case 'create_task': {
				const token = await getFreshToken(supa, row.user_id, 'tasks');
				if (!token) throw new Error('Tasks is not connected.');
				await tasksCreate(token, row.action_payload as Parameters<typeof tasksCreate>[1]);
				break;
			}
			case 'update_task': {
				const token = await getFreshToken(supa, row.user_id, 'tasks');
				if (!token) throw new Error('Tasks is not connected.');
				const payload = row.action_payload as { taskId: string };
				await tasksUpdate(token, payload.taskId, row.action_payload as Parameters<typeof tasksUpdate>[2]);
				break;
			}
			case 'complete_task': {
				const token = await getFreshToken(supa, row.user_id, 'tasks');
				if (!token) throw new Error('Tasks is not connected.');
				await tasksComplete(token, (row.action_payload as { taskId: string }).taskId);
				break;
			}
			case 'create_folder': {
				const token = await getFreshToken(supa, row.user_id, 'drive');
				if (!token) throw new Error('Drive is not connected.');
				await driveCreateFolder(token, row.action_payload as Parameters<typeof driveCreateFolder>[1]);
				break;
			}
			case 'move_file': {
				const token = await getFreshToken(supa, row.user_id, 'drive');
				if (!token) throw new Error('Drive is not connected.');
				const payload = row.action_payload as { fileId: string; targetFolderId: string };
				await driveMoveFile(token, payload.fileId, payload.targetFolderId);
				break;
			}
			case 'rename_file': {
				const token = await getFreshToken(supa, row.user_id, 'drive');
				if (!token) throw new Error('Drive is not connected.');
				const payload = row.action_payload as { fileId: string; newName: string };
				await driveRenameFile(token, payload.fileId, payload.newName);
				break;
			}
			case 'delete_file': {
				const token = await getFreshToken(supa, row.user_id, 'drive');
				if (!token) throw new Error('Drive is not connected.');
				const payload = row.action_payload as { fileId: string; permanently?: boolean };
				await driveDeleteFile(token, payload.fileId, payload.permanently ?? false);
				break;
			}
			case 'share_file': {
				const token = await getFreshToken(supa, row.user_id, 'drive');
				if (!token) throw new Error('Drive is not connected.');
				const payload = row.action_payload as { fileId: string } & Parameters<typeof driveSetPermissions>[2];
				await driveSetPermissions(token, payload.fileId, payload);
				break;
			}
			case 'create_document': {
				const token = await getFreshToken(supa, row.user_id, 'docs');
				if (!token) throw new Error('Docs is not connected.');
				await docsCreate(token, row.action_payload as Parameters<typeof docsCreate>[1]);
				break;
			}
			case 'update_document': {
				const token = await getFreshToken(supa, row.user_id, 'docs');
				if (!token) throw new Error('Docs is not connected.');
				const payload = row.action_payload as { documentId: string; mode?: 'append' | 'replace' };
				await docsUpdate(token, payload.documentId, { content: row.draft_content ?? '', mode: payload.mode });
				break;
			}
			case 'create_sheet': {
				const token = await getFreshToken(supa, row.user_id, 'sheets');
				if (!token) throw new Error('Sheets is not connected.');
				await sheetsCreate(token, row.action_payload as Parameters<typeof sheetsCreate>[1]);
				break;
			}
			case 'update_sheet': {
				const token = await getFreshToken(supa, row.user_id, 'sheets');
				if (!token) throw new Error('Sheets is not connected.');
				const payload = row.action_payload as { spreadsheetId: string };
				await sheetsUpdate(token, payload.spreadsheetId, row.action_payload as Parameters<typeof sheetsUpdate>[2]);
				break;
			}
			default: {
				await supa.from('approval_queue').update({ status: 'failed' }).eq('id', row.id);
				return new Response(JSON.stringify({ error: `no executor for '${row.action_type}' yet — nothing was performed` }), {
					headers: { 'Content-Type': 'application/json' },
				});
			}
		}

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
