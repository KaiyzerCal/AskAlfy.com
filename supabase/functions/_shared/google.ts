// Hand-rolled Google OAuth token refresh + Gmail/Calendar REST calls, replacing Composio
// for these two providers. Pattern ported from PrymalAI-dashboard's proven getFreshToken.

import type { createClient } from 'npm:@supabase/supabase-js';

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

type SupabaseClient = ReturnType<typeof createClient>;

// Returns a live access token for (userId, platform), refreshing via the stored
// refresh_token when the cached one is within 60s of expiring. Returns null if the
// platform was never connected or the refresh fails — callers surface that as
// "not connected yet" rather than throwing.
export async function getFreshToken(supabase: SupabaseClient, userId: string, platform: string): Promise<string | null> {
	const { data, error } = await supabase
		.from('oauth_tokens')
		.select('access_token, refresh_token, expires_at')
		.eq('user_id', userId)
		.eq('platform', platform)
		.single();

	if (error || !data) return null;

	const expiresAt = data.expires_at ? new Date(data.expires_at).getTime() : 0;
	if (Date.now() < expiresAt - 60_000) return data.access_token;
	if (!data.refresh_token) return null;

	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: data.refresh_token,
			client_id: GOOGLE_CLIENT_ID,
			client_secret: GOOGLE_CLIENT_SECRET,
		}),
	});
	const tokens = await res.json();
	if (!tokens.access_token) return null;

	await supabase.from('oauth_tokens').update({
		access_token: tokens.access_token,
		expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
		updated_at: new Date().toISOString(),
	}).eq('user_id', userId).eq('platform', platform);

	return tokens.access_token;
}

function base64url(input: string): string {
	return btoa(unescape(encodeURIComponent(input)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

interface SendEmailArgs {
	to: string;
	cc?: string | null;
	bcc?: string | null;
	subject: string;
	body: string;
}

function buildRawEmail({ to, cc, bcc, subject, body }: SendEmailArgs): string {
	const headers = [
		`To: ${to}`,
		cc ? `Cc: ${cc}` : null,
		bcc ? `Bcc: ${bcc}` : null,
		`Subject: ${subject}`,
		'Content-Type: text/plain; charset="UTF-8"',
		'MIME-Version: 1.0',
	].filter(Boolean).join('\r\n');
	return base64url(`${headers}\r\n\r\n${body}`);
}

export async function gmailSend(accessToken: string, args: SendEmailArgs) {
	const res = await fetch(`${GMAIL_BASE}/messages/send`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ raw: buildRawEmail(args) }),
	});
	if (!res.ok) throw new Error(`Gmail send failed: ${await res.text()}`);
	return await res.json();
}

export async function gmailList(accessToken: string, q: string | undefined, maxResults = 10) {
	const params = new URLSearchParams({ maxResults: String(Math.min(maxResults, 20)) });
	if (q) params.set('q', q);

	const listRes = await fetch(`${GMAIL_BASE}/messages?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	const list = await listRes.json();
	if (!list.messages) return [];

	return await Promise.all(
		list.messages.map(async (m: { id: string }) => {
			const res = await fetch(
				`${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
				{ headers: { Authorization: `Bearer ${accessToken}` } },
			);
			const msg = await res.json();
			const headers: Record<string, string> = {};
			for (const h of msg.payload?.headers ?? []) headers[h.name] = h.value;
			return { id: msg.id, threadId: msg.threadId, snippet: msg.snippet, from: headers.From, subject: headers.Subject, date: headers.Date };
		}),
	);
}

export async function gmailGetThread(accessToken: string, threadId: string) {
	const res = await fetch(`${GMAIL_BASE}/threads/${threadId}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Gmail thread lookup failed: ${await res.text()}`);
	return await res.json();
}

export async function gmailListLabels(accessToken: string) {
	const res = await fetch(`${GMAIL_BASE}/labels`, { headers: { Authorization: `Bearer ${accessToken}` } });
	const data = await res.json();
	return data.labels ?? [];
}

export async function gmailCreateLabel(accessToken: string, args: { name: string; labelListVisibility?: string; messageListVisibility?: string }) {
	const res = await fetch(`${GMAIL_BASE}/labels`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: args.name,
			labelListVisibility: args.labelListVisibility ?? 'labelShow',
			messageListVisibility: args.messageListVisibility ?? 'show',
		}),
	});
	if (!res.ok) throw new Error(`Gmail create label failed: ${await res.text()}`);
	return await res.json();
}

async function resolveLabelId(accessToken: string, labelName: string): Promise<string> {
	const labels = await gmailListLabels(accessToken);
	const found = labels.find((l: { name: string; id: string }) => l.name.toLowerCase() === labelName.toLowerCase());
	if (found) return found.id;
	const created = await gmailCreateLabel(accessToken, { name: labelName });
	return created.id;
}

async function gmailModifyThread(accessToken: string, threadId: string, body: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
	const res = await fetch(`${GMAIL_BASE}/threads/${threadId}/modify`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Gmail thread modify failed: ${await res.text()}`);
	return await res.json();
}

export async function gmailApplyLabel(accessToken: string, threadIds: string[], labelName: string) {
	const labelId = await resolveLabelId(accessToken, labelName);
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { addLabelIds: [labelId] })));
}

export async function gmailRemoveLabel(accessToken: string, threadIds: string[], labelName: string) {
	const labelId = await resolveLabelId(accessToken, labelName);
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { removeLabelIds: [labelId] })));
}

export async function gmailArchive(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { removeLabelIds: ['INBOX'] })));
}

export async function gmailMarkRead(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { removeLabelIds: ['UNREAD'] })));
}

export async function gmailMarkUnread(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map((id) => gmailModifyThread(accessToken, id, { addLabelIds: ['UNREAD'] })));
}

// Trash (reversible) rather than permanent delete.
export async function gmailTrash(accessToken: string, threadIds: string[]) {
	await Promise.all(threadIds.map(async (id) => {
		const res = await fetch(`${GMAIL_BASE}/threads/${id}/trash`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
		if (!res.ok) throw new Error(`Gmail trash failed: ${await res.text()}`);
	}));
}

interface CreateFilterArgs {
	from?: string;
	to?: string;
	subject?: string;
	query?: string;
	action: 'archive' | 'markRead' | 'star' | 'delete';
	label?: string;
}

export async function gmailCreateFilter(accessToken: string, args: CreateFilterArgs) {
	const criteria: Record<string, string> = {};
	if (args.from) criteria.from = args.from;
	if (args.to) criteria.to = args.to;
	if (args.subject) criteria.subject = args.subject;
	if (args.query) criteria.query = args.query;

	const addLabelIds: string[] = [];
	const removeLabelIds: string[] = [];
	if (args.action === 'archive') removeLabelIds.push('INBOX');
	else if (args.action === 'markRead') removeLabelIds.push('UNREAD');
	else if (args.action === 'star') addLabelIds.push('STARRED');
	else if (args.action === 'delete') addLabelIds.push('TRASH');
	if (args.label) addLabelIds.push(await resolveLabelId(accessToken, args.label));

	const action: Record<string, string[]> = {};
	if (addLabelIds.length) action.addLabelIds = addLabelIds;
	if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;

	const res = await fetch(`${GMAIL_BASE}/settings/filters`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ criteria, action }),
	});
	if (!res.ok) throw new Error(`Gmail create filter failed: ${await res.text()}`);
	return await res.json();
}

interface SetAutoReplyArgs {
	message: string;
	subject?: string;
	startTime?: string;
	endTime?: string;
	restrictToContacts?: boolean;
	restrictToDomain?: boolean;
}

export async function gmailSetAutoReply(accessToken: string, args: SetAutoReplyArgs) {
	const body: Record<string, unknown> = {
		enableAutoReply: true,
		responseBodyPlainText: args.message,
		responseSubject: args.subject,
		restrictToContacts: args.restrictToContacts ?? false,
		restrictToDomain: args.restrictToDomain ?? false,
	};
	if (args.startTime) body.startTime = new Date(args.startTime).getTime();
	if (args.endTime) body.endTime = new Date(args.endTime).getTime();

	const res = await fetch(`${GMAIL_BASE}/settings/vacation`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Gmail set vacation responder failed: ${await res.text()}`);
	return await res.json();
}

// Gmail has no scheduled-send API — save as a draft and tell the person to use
// Gmail's own Schedule Send from there.
export async function gmailCreateDraft(accessToken: string, args: SendEmailArgs) {
	const res = await fetch(`${GMAIL_BASE}/drafts`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ message: { raw: buildRawEmail(args) } }),
	});
	if (!res.ok) throw new Error(`Gmail create draft failed: ${await res.text()}`);
	return await res.json();
}

interface CalendarListArgs {
	timeMin?: string;
	timeMax?: string;
	maxResults?: number;
}

export async function calendarListEvents(accessToken: string, args: CalendarListArgs) {
	const params = new URLSearchParams({
		maxResults: String(Math.min(args.maxResults ?? 10, 25)),
		singleEvents: 'true',
		orderBy: 'startTime',
	});
	if (args.timeMin) params.set('timeMin', args.timeMin);
	if (args.timeMax) params.set('timeMax', args.timeMax);

	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	const data = await res.json();
	return (data.items ?? []).map((e: Record<string, unknown>) => ({
		id: e.id,
		summary: e.summary,
		start: e.start,
		end: e.end,
		location: e.location,
		attendees: e.attendees,
	}));
}

interface CreateEventArgs {
	title: string;
	startTime: string;
	endTime: string;
	location?: string | null;
	attendees?: string[] | null;
	description?: string | null;
}

export async function calendarCreateEvent(accessToken: string, args: CreateEventArgs) {
	const body = {
		summary: args.title,
		location: args.location ?? undefined,
		description: args.description ?? undefined,
		start: { dateTime: args.startTime },
		end: { dateTime: args.endTime },
		attendees: (args.attendees ?? []).map((email) => ({ email })),
	};
	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Calendar create failed: ${await res.text()}`);
	return await res.json();
}

export async function calendarUpdateEvent(accessToken: string, eventId: string, args: Partial<CreateEventArgs>) {
	const body: Record<string, unknown> = {};
	if (args.title !== undefined) body.summary = args.title;
	if (args.location !== undefined) body.location = args.location;
	if (args.description !== undefined) body.description = args.description;
	if (args.startTime !== undefined) body.start = { dateTime: args.startTime };
	if (args.endTime !== undefined) body.end = { dateTime: args.endTime };
	if (args.attendees !== undefined) body.attendees = (args.attendees ?? []).map((email) => ({ email }));

	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Calendar update failed: ${await res.text()}`);
	return await res.json();
}

export async function calendarDeleteEvent(accessToken: string, eventId: string) {
	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events/${eventId}`, {
		method: 'DELETE',
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	// 410 Gone means it was already deleted — treat as success.
	if (!res.ok && res.status !== 410) throw new Error(`Calendar delete failed: ${await res.text()}`);
}

export async function calendarScheduleMeet(accessToken: string, args: CreateEventArgs) {
	const body = {
		summary: args.title,
		location: args.location ?? undefined,
		description: args.description ?? undefined,
		start: { dateTime: args.startTime },
		end: { dateTime: args.endTime },
		attendees: (args.attendees ?? []).map((email) => ({ email })),
		conferenceData: {
			createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
		},
	};
	const res = await fetch(`${CALENDAR_BASE}/calendars/primary/events?conferenceDataVersion=1`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Calendar schedule meet failed: ${await res.text()}`);
	return await res.json();
}

export async function calendarGetAvailability(accessToken: string, args: { timeMin: string; timeMax: string }) {
	const res = await fetch(`${CALENDAR_BASE}/freeBusy`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ timeMin: args.timeMin, timeMax: args.timeMax, items: [{ id: 'primary' }] }),
	});
	if (!res.ok) throw new Error(`Calendar freebusy failed: ${await res.text()}`);
	const data = await res.json();
	return data.calendars?.primary?.busy ?? [];
}

// ── Google Tasks ────────────────────────────────────────────────────────────
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

export async function tasksList(accessToken: string) {
	const res = await fetch(`${TASKS_BASE}/lists/@default/tasks`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Tasks list failed: ${await res.text()}`);
	const data = await res.json();
	return (data.items ?? []).map((t: Record<string, unknown>) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due, status: t.status }));
}

export async function tasksCreate(accessToken: string, args: { title: string; description?: string | null; dueDate?: string | null }) {
	const res = await fetch(`${TASKS_BASE}/lists/@default/tasks`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: args.title, notes: args.description ?? undefined, due: args.dueDate ?? undefined }),
	});
	if (!res.ok) throw new Error(`Tasks create failed: ${await res.text()}`);
	return await res.json();
}

export async function tasksUpdate(accessToken: string, taskId: string, args: { title?: string; description?: string; dueDate?: string; status?: string }) {
	const body: Record<string, unknown> = {};
	if (args.title !== undefined) body.title = args.title;
	if (args.description !== undefined) body.notes = args.description;
	if (args.dueDate !== undefined) body.due = args.dueDate;
	if (args.status !== undefined) body.status = args.status;
	const res = await fetch(`${TASKS_BASE}/lists/@default/tasks/${taskId}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Tasks update failed: ${await res.text()}`);
	return await res.json();
}

export async function tasksComplete(accessToken: string, taskId: string) {
	return await tasksUpdate(accessToken, taskId, { status: 'completed' });
}

// ── Google Drive ─────────────────────────────────────────────────────────────
// Scope is drive.file: the app can only see files it created or the user explicitly
// opened with it, not the whole Drive. Full access needs Google's restricted-scope
// security review — fine for v1, flag it if "search my whole Drive" becomes a real ask.
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

export async function driveSearchFiles(accessToken: string, query: string | undefined, maxResults = 10) {
	const params = new URLSearchParams({
		pageSize: String(Math.min(maxResults, 25)),
		fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
	});
	if (query) params.set('q', query);
	const res = await fetch(`${DRIVE_BASE}/files?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Drive search failed: ${await res.text()}`);
	const data = await res.json();
	return data.files ?? [];
}

export async function driveGetFileInfo(accessToken: string, fileId: string) {
	const res = await fetch(
		`${DRIVE_BASE}/files/${fileId}?fields=id,name,mimeType,parents,modifiedTime,webViewLink,size`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);
	if (!res.ok) throw new Error(`Drive file info failed: ${await res.text()}`);
	return await res.json();
}

// Google Docs/Sheets/Slides need export to a plain format; regular files download as-is.
const DRIVE_EXPORT_MIME: Record<string, string> = {
	'application/vnd.google-apps.document': 'text/plain',
	'application/vnd.google-apps.spreadsheet': 'text/csv',
	'application/vnd.google-apps.presentation': 'text/plain',
};

export async function driveReadFileContent(accessToken: string, fileId: string) {
	const meta = await driveGetFileInfo(accessToken, fileId);
	const exportMime = DRIVE_EXPORT_MIME[meta.mimeType as string];
	const url = exportMime
		? `${DRIVE_BASE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`
		: `${DRIVE_BASE}/files/${fileId}?alt=media`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Drive read failed: ${await res.text()}`);
	return await res.text();
}

async function driveCreateFile(accessToken: string, name: string, mimeType: string, parentFolderId?: string | null) {
	const body: Record<string, unknown> = { name, mimeType };
	if (parentFolderId) body.parents = [parentFolderId];
	const res = await fetch(`${DRIVE_BASE}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Drive create failed: ${await res.text()}`);
	return await res.json();
}

export async function driveCreateFolder(accessToken: string, args: { name: string; parentFolderId?: string | null }) {
	return await driveCreateFile(accessToken, args.name, 'application/vnd.google-apps.folder', args.parentFolderId);
}

export async function driveMoveFile(accessToken: string, fileId: string, targetFolderId: string) {
	const current = await driveGetFileInfo(accessToken, fileId);
	const previousParents = ((current.parents as string[] | undefined) ?? []).join(',');
	const params = new URLSearchParams({ addParents: targetFolderId, fields: 'id,parents' });
	if (previousParents) params.set('removeParents', previousParents);
	const res = await fetch(`${DRIVE_BASE}/files/${fileId}?${params}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Drive move failed: ${await res.text()}`);
	return await res.json();
}

export async function driveRenameFile(accessToken: string, fileId: string, newName: string) {
	const res = await fetch(`${DRIVE_BASE}/files/${fileId}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: newName }),
	});
	if (!res.ok) throw new Error(`Drive rename failed: ${await res.text()}`);
	return await res.json();
}

export async function driveDeleteFile(accessToken: string, fileId: string, permanently: boolean) {
	if (permanently) {
		const res = await fetch(`${DRIVE_BASE}/files/${fileId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
		if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed: ${await res.text()}`);
		return;
	}
	const res = await fetch(`${DRIVE_BASE}/files/${fileId}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ trashed: true }),
	});
	if (!res.ok) throw new Error(`Drive trash failed: ${await res.text()}`);
}

// Covers both "share with specific people" (emailAddresses set) and "anyone with the
// link" (type: 'anyone', no addresses needed) in one tool/executor.
export async function driveSetPermissions(
	accessToken: string,
	fileId: string,
	args: { emailAddresses?: string[] | null; role: string; type?: string; sendNotification?: boolean },
) {
	const grant = async (type: string, value?: string) => {
		const params = new URLSearchParams({ sendNotificationEmail: String(args.sendNotification ?? true) });
		const body: Record<string, unknown> = { type, role: args.role };
		if (value) body.emailAddress = value;
		const res = await fetch(`${DRIVE_BASE}/files/${fileId}/permissions?${params}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Drive permission failed: ${await res.text()}`);
		return await res.json();
	};

	if (args.type === 'anyone') return [await grant('anyone')];
	const addresses = args.emailAddresses ?? [];
	return await Promise.all(addresses.map((email) => grant('user', email)));
}

// ── Google Docs / Sheets (creation rides Drive's files.create) ───────────────
const DOCS_BASE = 'https://docs.googleapis.com/v1/documents';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export async function docsCreate(accessToken: string, args: { title: string; content?: string | null; parentFolderId?: string | null }) {
	const file = await driveCreateFile(accessToken, args.title, 'application/vnd.google-apps.document', args.parentFolderId);
	if (args.content) {
		await fetch(`${DOCS_BASE}/${file.id}:batchUpdate`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: args.content } }] }),
		});
	}
	return file;
}

function docsEndIndex(doc: { body?: { content?: { endIndex?: number }[] } }): number {
	const content = doc.body?.content ?? [];
	return content[content.length - 1]?.endIndex ?? 1;
}

export async function docsUpdate(accessToken: string, documentId: string, args: { content: string; mode?: 'append' | 'replace' }) {
	const docRes = await fetch(`${DOCS_BASE}/${documentId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!docRes.ok) throw new Error(`Docs read failed: ${await docRes.text()}`);
	const doc = await docRes.json();
	const endIndex = docsEndIndex(doc);

	const requests: Record<string, unknown>[] = [];
	if (args.mode === 'replace' && endIndex > 2) {
		requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
		requests.push({ insertText: { location: { index: 1 }, text: args.content } });
	} else {
		requests.push({ insertText: { location: { index: Math.max(endIndex - 1, 1) }, text: args.content } });
	}

	const res = await fetch(`${DOCS_BASE}/${documentId}:batchUpdate`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ requests }),
	});
	if (!res.ok) throw new Error(`Docs update failed: ${await res.text()}`);
	return await res.json();
}

export async function sheetsCreate(accessToken: string, args: { title: string; parentFolderId?: string | null }) {
	return await driveCreateFile(accessToken, args.title, 'application/vnd.google-apps.spreadsheet', args.parentFolderId);
}

export async function sheetsRead(accessToken: string, spreadsheetId: string, range?: string) {
	const url = range
		? `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`
		: `${SHEETS_BASE}/${spreadsheetId}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Sheets read failed: ${await res.text()}`);
	return await res.json();
}

export async function sheetsUpdate(
	accessToken: string,
	spreadsheetId: string,
	args: { sheetName?: string | null; range: string; values: unknown[][]; mode?: 'append' | 'overwrite' },
) {
	const fullRange = args.sheetName ? `${args.sheetName}!${args.range}` : args.range;
	const encoded = encodeURIComponent(fullRange);

	if (args.mode === 'append') {
		const res = await fetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ values: args.values }),
		});
		if (!res.ok) throw new Error(`Sheets append failed: ${await res.text()}`);
		return await res.json();
	}

	const res = await fetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ values: args.values }),
	});
	if (!res.ok) throw new Error(`Sheets update failed: ${await res.text()}`);
	return await res.json();
}
