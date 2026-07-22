// The action_type → real API call switch. Extracted from alfy-approve so a second caller —
// the standing-permission auto-execute path in _shared/agent.ts's queue() — can replay the
// exact same executors without a human tap. Two callers, one place these ever fire from.
//
// This is still the ONLY code that calls an outbound Google API. Both callers reach it only
// after a "yes" already happened: a tap on Approve, or a standing permission granted earlier
// (itself a yes, just a durable one). Nothing here decides whether to ask — that's upstream.

import type { createClient } from 'npm:@supabase/supabase-js';
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
} from './google.ts';

type SupabaseClient = ReturnType<typeof createClient>;

export class UnknownActionError extends Error {}

// Overridden for actions where "Done" would overstate what happened (e.g. schedule_send,
// which Gmail can't actually schedule — it becomes a draft, not a sent message).
export async function executeAction(
	supa: SupabaseClient,
	userId: string,
	actionType: string,
	actionPayload: Record<string, unknown>,
	draftContent: string | null,
): Promise<{ confirmationText?: string }> {
	switch (actionType) {
		case 'send_email': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			const payload = actionPayload as { to: string; cc?: string | null; bcc?: string | null; subject: string };
			await gmailSend(token, { ...payload, body: draftContent ?? '' });
			return {};
		}
		case 'create_event': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) throw new Error('Calendar is not connected.');
			await calendarCreateEvent(token, actionPayload as Parameters<typeof calendarCreateEvent>[1]);
			return {};
		}
		case 'create_label': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			await gmailCreateLabel(token, actionPayload as { name: string });
			return {};
		}
		case 'apply_label': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			const payload = actionPayload as { threadIds: string[]; labelName: string };
			await gmailApplyLabel(token, payload.threadIds, payload.labelName);
			return {};
		}
		case 'remove_label': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			const payload = actionPayload as { threadIds: string[]; labelName: string };
			await gmailRemoveLabel(token, payload.threadIds, payload.labelName);
			return {};
		}
		case 'archive_email': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			await gmailArchive(token, (actionPayload as { threadIds: string[] }).threadIds);
			return {};
		}
		case 'mark_as_read': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			await gmailMarkRead(token, (actionPayload as { threadIds: string[] }).threadIds);
			return {};
		}
		case 'mark_as_unread': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			await gmailMarkUnread(token, (actionPayload as { threadIds: string[] }).threadIds);
			return {};
		}
		case 'delete_email': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			await gmailTrash(token, (actionPayload as { threadIds: string[] }).threadIds);
			return {};
		}
		case 'create_filter': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			await gmailCreateFilter(token, actionPayload as Parameters<typeof gmailCreateFilter>[1]);
			return {};
		}
		case 'set_auto_reply': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			const payload = actionPayload as { subject?: string; startTime?: string; endTime?: string; restrictToContacts?: boolean; restrictToDomain?: boolean };
			await gmailSetAutoReply(token, { ...payload, message: draftContent ?? '' });
			return {};
		}
		case 'schedule_send': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) throw new Error('Gmail is not connected.');
			const payload = actionPayload as { to: string; cc?: string | null; bcc?: string | null; subject: string; sendAt: string };
			await gmailCreateDraft(token, { to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, body: draftContent ?? '' });
			return { confirmationText: "Saved as a draft — Gmail doesn't support scheduled send yet, so finish it there when you're ready. — A" };
		}
		case 'update_event': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) throw new Error('Calendar is not connected.');
			const payload = actionPayload as { eventId: string };
			await calendarUpdateEvent(token, payload.eventId, actionPayload as Parameters<typeof calendarUpdateEvent>[2]);
			return {};
		}
		case 'delete_event': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) throw new Error('Calendar is not connected.');
			await calendarDeleteEvent(token, (actionPayload as { eventId: string }).eventId);
			return {};
		}
		case 'schedule_meet': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) throw new Error('Calendar is not connected.');
			await calendarScheduleMeet(token, actionPayload as Parameters<typeof calendarScheduleMeet>[1]);
			return {};
		}
		case 'create_task': {
			const token = await getFreshToken(supa, userId, 'tasks');
			if (!token) throw new Error('Tasks is not connected.');
			await tasksCreate(token, actionPayload as Parameters<typeof tasksCreate>[1]);
			return {};
		}
		case 'update_task': {
			const token = await getFreshToken(supa, userId, 'tasks');
			if (!token) throw new Error('Tasks is not connected.');
			const payload = actionPayload as { taskId: string };
			await tasksUpdate(token, payload.taskId, actionPayload as Parameters<typeof tasksUpdate>[2]);
			return {};
		}
		case 'complete_task': {
			const token = await getFreshToken(supa, userId, 'tasks');
			if (!token) throw new Error('Tasks is not connected.');
			await tasksComplete(token, (actionPayload as { taskId: string }).taskId);
			return {};
		}
		case 'create_folder': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) throw new Error('Drive is not connected.');
			await driveCreateFolder(token, actionPayload as Parameters<typeof driveCreateFolder>[1]);
			return {};
		}
		case 'move_file': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) throw new Error('Drive is not connected.');
			const payload = actionPayload as { fileId: string; targetFolderId: string };
			await driveMoveFile(token, payload.fileId, payload.targetFolderId);
			return {};
		}
		case 'rename_file': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) throw new Error('Drive is not connected.');
			const payload = actionPayload as { fileId: string; newName: string };
			await driveRenameFile(token, payload.fileId, payload.newName);
			return {};
		}
		case 'delete_file': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) throw new Error('Drive is not connected.');
			const payload = actionPayload as { fileId: string; permanently?: boolean };
			await driveDeleteFile(token, payload.fileId, payload.permanently ?? false);
			return {};
		}
		case 'share_file': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) throw new Error('Drive is not connected.');
			const payload = actionPayload as { fileId: string } & Parameters<typeof driveSetPermissions>[2];
			await driveSetPermissions(token, payload.fileId, payload);
			return {};
		}
		case 'create_document': {
			const token = await getFreshToken(supa, userId, 'docs');
			if (!token) throw new Error('Docs is not connected.');
			await docsCreate(token, actionPayload as Parameters<typeof docsCreate>[1]);
			return {};
		}
		case 'update_document': {
			const token = await getFreshToken(supa, userId, 'docs');
			if (!token) throw new Error('Docs is not connected.');
			const payload = actionPayload as { documentId: string; mode?: 'append' | 'replace' };
			await docsUpdate(token, payload.documentId, { content: draftContent ?? '', mode: payload.mode });
			return {};
		}
		case 'create_sheet': {
			const token = await getFreshToken(supa, userId, 'sheets');
			if (!token) throw new Error('Sheets is not connected.');
			await sheetsCreate(token, actionPayload as Parameters<typeof sheetsCreate>[1]);
			return {};
		}
		case 'update_sheet': {
			const token = await getFreshToken(supa, userId, 'sheets');
			if (!token) throw new Error('Sheets is not connected.');
			const payload = actionPayload as { spreadsheetId: string };
			await sheetsUpdate(token, payload.spreadsheetId, actionPayload as Parameters<typeof sheetsUpdate>[2]);
			return {};
		}
		default:
			throw new UnknownActionError(`no executor for '${actionType}' yet — nothing was performed`);
	}
}
