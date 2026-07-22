// alfy-agent — the brain. Anthropic tool-use loop, forked from Prymal's prymal-chat.
// Invariant that mirrors the brand ("Alfy asks first"): the agent NEVER sends or acts
// externally. Reads are direct (Gmail/Calendar REST via _shared/google.ts); anything
// outbound is queued via a dedicated action tool (or queue_action as a fallback) and
// only executed after approval (see alfy-approve).
//
// Lives here rather than in supabase/functions/alfy-agent/index.ts so alfy-sms-inbound
// can import it without relying on Supabase's per-folder function bundling.

import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';
import {
	calendarGetAvailability,
	calendarListEvents,
	driveGetFileInfo,
	driveReadFileContent,
	driveSearchFiles,
	getFreshToken,
	gmailGetThread,
	gmailList,
	gmailListLabels,
	sheetsRead,
	tasksList,
} from './google.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!; // platform pays inference (consumer SMS)

const SYSTEM_PROMPT = `You are Alfy — a warm, comfortably competent assistant a person texts.

Voice: plain words, contractions, no exclamation marks, no emoji, sentence case. Report what
you did, then ask. Max 5 lines. Sign off "— A". Never say "as an AI". Never use hype words.

RULES — never break these:
1. You never send, book, buy, or pay directly. Reading is always fine — do it freely.
2. For anything that leaves the person (an email, a calendar invite, an order), call the
   matching action tool (send_email, create_event, ...) — or queue_action if there's no
   dedicated tool yet. It waits for their yes in the dashboard; they get a link to approve.
3. Draft in the person's voice using their context. If you lack something you need, ask.
4. Be specific: say what you found, what you drafted, and that it's waiting for their yes.`;

const TOOLS: Anthropic.Tool[] = [
	{
		name: 'get_context',
		description: "The person's profile, people they know, and standing okays.",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'get_emails',
		description: 'Search recent Gmail messages (read-only). Use Gmail search syntax for q, e.g. "from:dana is:unread".',
		input_schema: {
			type: 'object',
			properties: { q: { type: 'string' }, maxResults: { type: 'number', default: 10 } },
		},
	},
	{
		name: 'get_email_thread',
		description: 'Read a full Gmail thread by id (read-only).',
		input_schema: { type: 'object', properties: { threadId: { type: 'string' } }, required: ['threadId'] },
	},
	{
		name: 'list_labels',
		description: 'List the Gmail labels on this account (read-only).',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'get_calendar_events',
		description: 'List upcoming or past calendar events (read-only).',
		input_schema: {
			type: 'object',
			properties: {
				timeMin: { type: 'string' },
				timeMax: { type: 'string' },
				maxResults: { type: 'number', default: 10 },
			},
		},
	},
	{
		name: 'send_email',
		description: 'Draft and queue an email for the person to approve. Nothing sends until they say yes.',
		input_schema: {
			type: 'object',
			properties: {
				to: { type: 'string' },
				cc: { type: 'string' },
				bcc: { type: 'string' },
				subject: { type: 'string' },
				body: { type: 'string' },
			},
			required: ['to', 'subject', 'body'],
		},
	},
	{
		name: 'create_event',
		description: 'Draft and queue a calendar event for the person to approve. Nothing is created until they say yes.',
		input_schema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				startTime: { type: 'string' },
				endTime: { type: 'string' },
				location: { type: 'string' },
				attendees: { type: 'array', items: { type: 'string' } },
				description: { type: 'string' },
			},
			required: ['title', 'startTime', 'endTime'],
		},
	},
	{
		name: 'get_availability',
		description: 'Check free/busy blocks on the calendar for a time range (read-only).',
		input_schema: {
			type: 'object',
			properties: { timeMin: { type: 'string' }, timeMax: { type: 'string' } },
			required: ['timeMin', 'timeMax'],
		},
	},
	{
		name: 'remember_contact',
		description: "Save or update what Alfy knows about someone — not an outbound action, just memory. Rewrite context_summary to stay current rather than letting it grow forever; do this quietly, don't announce it.",
		input_schema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				email: { type: 'string' },
				company: { type: 'string' },
				context_summary: { type: 'string', description: 'Plain-language notes, replaces what was there before' },
				tags: { type: 'array', items: { type: 'string' } },
				birthday: { type: 'string', description: 'Free text, e.g. "March 3" — year optional' },
			},
			required: ['name'],
		},
	},
	{
		name: 'recall_contacts',
		description: 'Search what Alfy knows about people (read-only). Use query for free-text name/email/company/notes matching, tag to filter by tag, or stale_days to find people not heard from in a while.',
		input_schema: {
			type: 'object',
			properties: {
				query: { type: 'string' },
				tag: { type: 'string' },
				stale_days: { type: 'number' },
				limit: { type: 'number', default: 20 },
			},
		},
	},
	{
		name: 'create_label',
		description: 'Draft and queue a new Gmail label for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
		},
	},
	{
		name: 'apply_label',
		description: 'Queue applying a label to one or more email threads for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { threadIds: { type: 'array', items: { type: 'string' } }, labelName: { type: 'string' } },
			required: ['threadIds', 'labelName'],
		},
	},
	{
		name: 'remove_label',
		description: 'Queue removing a label from one or more email threads for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { threadIds: { type: 'array', items: { type: 'string' } }, labelName: { type: 'string' } },
			required: ['threadIds', 'labelName'],
		},
	},
	{
		name: 'archive_email',
		description: 'Queue archiving one or more email threads for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { threadIds: { type: 'array', items: { type: 'string' } } },
			required: ['threadIds'],
		},
	},
	{
		name: 'mark_as_read',
		description: 'Queue marking one or more email threads as read for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { threadIds: { type: 'array', items: { type: 'string' } } },
			required: ['threadIds'],
		},
	},
	{
		name: 'mark_as_unread',
		description: 'Queue marking one or more email threads as unread for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { threadIds: { type: 'array', items: { type: 'string' } } },
			required: ['threadIds'],
		},
	},
	{
		name: 'delete_email',
		description: 'Queue moving one or more email threads to trash (reversible) for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { threadIds: { type: 'array', items: { type: 'string' } } },
			required: ['threadIds'],
		},
	},
	{
		name: 'create_filter',
		description: 'Draft and queue a Gmail filter rule for the person to approve.',
		input_schema: {
			type: 'object',
			properties: {
				from: { type: 'string' },
				to: { type: 'string' },
				subject: { type: 'string' },
				query: { type: 'string' },
				action: { type: 'string', enum: ['archive', 'markRead', 'star', 'delete'] },
				label: { type: 'string' },
			},
			required: ['action'],
		},
	},
	{
		name: 'set_auto_reply',
		description: "Draft and queue turning on Gmail's vacation auto-reply for the person to approve.",
		input_schema: {
			type: 'object',
			properties: {
				message: { type: 'string' },
				subject: { type: 'string' },
				startTime: { type: 'string' },
				endTime: { type: 'string' },
				restrictToContacts: { type: 'boolean' },
				restrictToDomain: { type: 'boolean' },
			},
			required: ['message'],
		},
	},
	{
		name: 'schedule_send',
		description: "Draft and queue an email to send later. Gmail has no scheduled-send API, so on approval this saves a draft and Alfy tells the person to use Gmail's own Schedule Send.",
		input_schema: {
			type: 'object',
			properties: {
				to: { type: 'string' },
				cc: { type: 'string' },
				bcc: { type: 'string' },
				subject: { type: 'string' },
				body: { type: 'string' },
				sendAt: { type: 'string' },
			},
			required: ['to', 'subject', 'body', 'sendAt'],
		},
	},
	{
		name: 'update_event',
		description: 'Draft and queue changes to an existing calendar event for the person to approve.',
		input_schema: {
			type: 'object',
			properties: {
				eventId: { type: 'string' },
				title: { type: 'string' },
				startTime: { type: 'string' },
				endTime: { type: 'string' },
				location: { type: 'string' },
				attendees: { type: 'array', items: { type: 'string' } },
				description: { type: 'string' },
			},
			required: ['eventId'],
		},
	},
	{
		name: 'delete_event',
		description: 'Queue deleting a calendar event for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { eventId: { type: 'string' } },
			required: ['eventId'],
		},
	},
	{
		name: 'schedule_meet',
		description: 'Draft and queue a calendar event with a Google Meet video link for the person to approve.',
		input_schema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				startTime: { type: 'string' },
				endTime: { type: 'string' },
				attendees: { type: 'array', items: { type: 'string' } },
				description: { type: 'string' },
			},
			required: ['title', 'startTime', 'endTime'],
		},
	},
	{
		name: 'list_tasks',
		description: 'List tasks on the default Google Tasks list (read-only).',
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'create_task',
		description: 'Draft and queue a new task for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { title: { type: 'string' }, description: { type: 'string' }, dueDate: { type: 'string' } },
			required: ['title'],
		},
	},
	{
		name: 'update_task',
		description: 'Draft and queue changes to an existing task for the person to approve.',
		input_schema: {
			type: 'object',
			properties: {
				taskId: { type: 'string' },
				title: { type: 'string' },
				description: { type: 'string' },
				dueDate: { type: 'string' },
				status: { type: 'string' },
			},
			required: ['taskId'],
		},
	},
	{
		name: 'complete_task',
		description: 'Queue marking a task complete for the person to approve.',
		input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
	},
	{
		name: 'search_drive_files',
		description: 'Search or list recent files in Drive that this app can see — files it created or the person opened with it (read-only). Omit query to list recent files.',
		input_schema: {
			type: 'object',
			properties: { query: { type: 'string' }, maxResults: { type: 'number', default: 10 } },
		},
	},
	{
		name: 'get_file_info',
		description: 'Get metadata for a Drive file by id (read-only).',
		input_schema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
	},
	{
		name: 'read_drive_file',
		description: 'Read the text content of a Drive file by id — Docs/Sheets/Slides are exported to plain text (read-only). For structured spreadsheet cells, use read_sheet instead.',
		input_schema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
	},
	{
		name: 'read_document',
		description: 'Read a Google Doc as plain text by id (read-only).',
		input_schema: { type: 'object', properties: { documentId: { type: 'string' } }, required: ['documentId'] },
	},
	{
		name: 'read_sheet',
		description: 'Read structured cell values from a Google Sheet (read-only). Omit range to read the whole spreadsheet.',
		input_schema: {
			type: 'object',
			properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } },
			required: ['spreadsheetId'],
		},
	},
	{
		name: 'create_folder',
		description: 'Draft and queue creating a new Drive folder for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { name: { type: 'string' }, parentFolderId: { type: 'string' } },
			required: ['name'],
		},
	},
	{
		name: 'move_file',
		description: 'Queue moving a Drive file into another folder for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { fileId: { type: 'string' }, targetFolderId: { type: 'string' } },
			required: ['fileId', 'targetFolderId'],
		},
	},
	{
		name: 'rename_file',
		description: 'Queue renaming a Drive file for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { fileId: { type: 'string' }, newName: { type: 'string' } },
			required: ['fileId', 'newName'],
		},
	},
	{
		name: 'delete_file',
		description: 'Queue deleting a Drive file for the person to approve. Defaults to trash (reversible) unless permanently is true.',
		input_schema: {
			type: 'object',
			properties: { fileId: { type: 'string' }, permanently: { type: 'boolean', default: false } },
			required: ['fileId'],
		},
	},
	{
		name: 'share_file',
		description: "Queue sharing a Drive file for the person to approve — either with specific people (emailAddresses) or as an 'anyone with the link' grant (type: 'anyone').",
		input_schema: {
			type: 'object',
			properties: {
				fileId: { type: 'string' },
				emailAddresses: { type: 'array', items: { type: 'string' } },
				role: { type: 'string', enum: ['reader', 'commenter', 'writer'] },
				type: { type: 'string', enum: ['user', 'anyone'], default: 'user' },
				sendNotification: { type: 'boolean' },
			},
			required: ['role'],
		},
	},
	{
		name: 'create_document',
		description: 'Draft and queue a new Google Doc for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { title: { type: 'string' }, content: { type: 'string' }, parentFolderId: { type: 'string' } },
			required: ['title'],
		},
	},
	{
		name: 'update_document',
		description: 'Draft and queue changes to an existing Google Doc for the person to approve.',
		input_schema: {
			type: 'object',
			properties: {
				documentId: { type: 'string' },
				content: { type: 'string' },
				mode: { type: 'string', enum: ['append', 'replace'], default: 'append' },
			},
			required: ['documentId', 'content'],
		},
	},
	{
		name: 'create_sheet',
		description: 'Draft and queue a new Google Sheet for the person to approve.',
		input_schema: {
			type: 'object',
			properties: { title: { type: 'string' }, parentFolderId: { type: 'string' } },
			required: ['title'],
		},
	},
	{
		name: 'update_sheet',
		description: 'Draft and queue writing values into a Google Sheet range for the person to approve.',
		input_schema: {
			type: 'object',
			properties: {
				spreadsheetId: { type: 'string' },
				sheetName: { type: 'string' },
				range: { type: 'string' },
				values: { type: 'array', items: { type: 'array' }, description: '2D array of row values' },
				mode: { type: 'string', enum: ['append', 'overwrite'], default: 'overwrite' },
			},
			required: ['spreadsheetId', 'range', 'values'],
		},
	},
	{
		name: 'create_standing_instruction',
		description: 'Set up an ongoing check Alfy runs on a schedule (e.g. "never let me miss a birthday", "tell me if a bill looks overdue"). Not an outbound action — just sets up future automated checking. Store the goal verbatim, no special-casing by type.',
		input_schema: {
			type: 'object',
			properties: {
				goal_text: { type: 'string' },
				cadence: { type: 'string', enum: ['hourly', 'daily', 'weekly'], default: 'daily' },
			},
			required: ['goal_text'],
		},
	},
	{
		name: 'list_standing_instructions',
		description: "List the person's active standing instructions (read-only).",
		input_schema: { type: 'object', properties: {} },
	},
	{
		name: 'cancel_standing_instruction',
		description: 'Cancel a standing instruction the person no longer wants.',
		input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
	},
	{
		name: 'queue_action',
		description: "Queue an outbound action with no dedicated tool yet, for the person to approve. Nothing happens until they say yes.",
		input_schema: {
			type: 'object',
			properties: {
				kind: { type: 'string', description: 'Card label: Email | Calendar | Order' },
				summary: { type: 'string', description: '"Reply to Dana about Thursday"' },
				draft_content: { type: 'string', description: 'The draft they will see and approve' },
				action_type: { type: 'string', description: 'A short machine name for this action' },
				action_payload: { type: 'object', description: 'Args an executor will need on approval' },
			},
			required: ['kind', 'summary', 'action_type', 'action_payload'],
		},
	},
];

const NOT_CONNECTED = (provider: string) => ({
	error: `${provider} is not connected yet. Ask the person to connect it in Settings.`,
});

// Every outbound action funnels through here: insert a pending approval_queue row and
// return, never call the destination API directly. alfy-approve replays it after a yes.
async function queue(
	supa: ReturnType<typeof createClient>,
	userId: string,
	args: { kind: string; summary: string; draft_content?: string | null; action_type: string; action_payload: Record<string, unknown> },
) {
	const { data, error } = await supa.from('approval_queue').insert({
		user_id: userId,
		kind: args.kind,
		summary: args.summary,
		draft_content: args.draft_content ?? null,
		action_type: args.action_type,
		action_payload: args.action_payload,
		status: 'pending',
	}).select('id').single();
	if (error) throw new Error(error.message);
	return { queued: true, id: data?.id };
}

async function handleTool(name: string, input: Record<string, unknown>, supa: ReturnType<typeof createClient>, userId: string) {
	switch (name) {
		case 'get_context': {
			const [{ data: user }, { data: people }, { data: perms }] = await Promise.all([
				supa.from('users').select('display_name, about, timezone').eq('id', userId).single(),
				supa.from('people').select('name, context_summary').eq('user_id', userId),
				supa.from('standing_permissions').select('description, action_type').eq('user_id', userId).is('revoked_at', null),
			]);
			return { user, people: people ?? [], standing_okays: perms ?? [] };
		}
		case 'get_emails': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) return NOT_CONNECTED('Gmail');
			return await gmailList(token, input.q as string | undefined, (input.maxResults as number) ?? 10);
		}
		case 'get_email_thread': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) return NOT_CONNECTED('Gmail');
			return await gmailGetThread(token, input.threadId as string);
		}
		case 'list_labels': {
			const token = await getFreshToken(supa, userId, 'gmail');
			if (!token) return NOT_CONNECTED('Gmail');
			return await gmailListLabels(token);
		}
		case 'get_calendar_events': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) return NOT_CONNECTED('Calendar');
			return await calendarListEvents(token, input as { timeMin?: string; timeMax?: string; maxResults?: number });
		}
		case 'get_availability': {
			const token = await getFreshToken(supa, userId, 'calendar');
			if (!token) return NOT_CONNECTED('Calendar');
			return await calendarGetAvailability(token, input as { timeMin: string; timeMax: string });
		}
		case 'remember_contact': {
			const email = (input.email as string | undefined) ?? null;
			const row = {
				user_id: userId,
				name: input.name,
				email,
				company: input.company ?? null,
				context_summary: input.context_summary ?? null,
				tags: input.tags ?? [],
				birthday: input.birthday ?? null,
				last_interaction: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			};
			const { data, error } = email
				? await supa.from('people').upsert(row, { onConflict: 'user_id,email' }).select('id').single()
				: await supa.from('people').insert(row).select('id').single();
			if (error) throw new Error(error.message);
			return { saved: true, id: data?.id };
		}
		case 'recall_contacts': {
			let q = supa.from('people').select('name, email, company, context_summary, tags, birthday, last_interaction').eq('user_id', userId);
			const query = input.query as string | undefined;
			if (query) q = q.or(`name.ilike.%${query}%,email.ilike.%${query}%,company.ilike.%${query}%,context_summary.ilike.%${query}%`);
			const tag = input.tag as string | undefined;
			if (tag) q = q.contains('tags', [tag]);
			const staleDays = input.stale_days as number | undefined;
			if (staleDays) q = q.lt('last_interaction', new Date(Date.now() - staleDays * 864e5).toISOString());
			const { data, error } = await q.order('updated_at', { ascending: false }).limit((input.limit as number) ?? 20);
			if (error) throw new Error(error.message);
			return data ?? [];
		}
		case 'send_email':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Email to ${input.to}: ${input.subject}`,
				draft_content: input.body as string,
				action_type: 'send_email',
				action_payload: { to: input.to, cc: input.cc ?? null, bcc: input.bcc ?? null, subject: input.subject },
			});
		case 'create_event':
			return await queue(supa, userId, {
				kind: 'Calendar',
				summary: String(input.title),
				draft_content: (input.description as string | undefined) ?? null,
				action_type: 'create_event',
				action_payload: {
					title: input.title,
					startTime: input.startTime,
					endTime: input.endTime,
					location: input.location ?? null,
					attendees: input.attendees ?? [],
					description: input.description ?? null,
				},
			});
		case 'create_label':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `New label: ${input.name}`,
				action_type: 'create_label',
				action_payload: { name: input.name },
			});
		case 'apply_label':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Label "${input.labelName}" on ${(input.threadIds as unknown[]).length} email(s)`,
				action_type: 'apply_label',
				action_payload: { threadIds: input.threadIds, labelName: input.labelName },
			});
		case 'remove_label':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Remove label "${input.labelName}" from ${(input.threadIds as unknown[]).length} email(s)`,
				action_type: 'remove_label',
				action_payload: { threadIds: input.threadIds, labelName: input.labelName },
			});
		case 'archive_email':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Archive ${(input.threadIds as unknown[]).length} email(s)`,
				action_type: 'archive_email',
				action_payload: { threadIds: input.threadIds },
			});
		case 'mark_as_read':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Mark ${(input.threadIds as unknown[]).length} email(s) as read`,
				action_type: 'mark_as_read',
				action_payload: { threadIds: input.threadIds },
			});
		case 'mark_as_unread':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Mark ${(input.threadIds as unknown[]).length} email(s) as unread`,
				action_type: 'mark_as_unread',
				action_payload: { threadIds: input.threadIds },
			});
		case 'delete_email':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Trash ${(input.threadIds as unknown[]).length} email(s)`,
				action_type: 'delete_email',
				action_payload: { threadIds: input.threadIds },
			});
		case 'create_filter':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `New filter: ${input.action}${input.label ? ` → ${input.label}` : ''}`,
				action_type: 'create_filter',
				action_payload: { from: input.from, to: input.to, subject: input.subject, query: input.query, action: input.action, label: input.label },
			});
		case 'set_auto_reply':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: 'Turn on vacation auto-reply',
				draft_content: input.message as string,
				action_type: 'set_auto_reply',
				action_payload: {
					subject: input.subject,
					startTime: input.startTime,
					endTime: input.endTime,
					restrictToContacts: input.restrictToContacts,
					restrictToDomain: input.restrictToDomain,
				},
			});
		case 'schedule_send':
			return await queue(supa, userId, {
				kind: 'Email',
				summary: `Email to ${input.to} at ${input.sendAt}: ${input.subject}`,
				draft_content: input.body as string,
				action_type: 'schedule_send',
				action_payload: { to: input.to, cc: input.cc ?? null, bcc: input.bcc ?? null, subject: input.subject, sendAt: input.sendAt },
			});
		case 'update_event':
			return await queue(supa, userId, {
				kind: 'Calendar',
				summary: `Update ${input.title ?? 'event'}`,
				draft_content: (input.description as string | undefined) ?? null,
				action_type: 'update_event',
				action_payload: {
					eventId: input.eventId,
					title: input.title,
					startTime: input.startTime,
					endTime: input.endTime,
					location: input.location,
					attendees: input.attendees,
					description: input.description,
				},
			});
		case 'delete_event':
			return await queue(supa, userId, {
				kind: 'Calendar',
				summary: 'Delete calendar event',
				action_type: 'delete_event',
				action_payload: { eventId: input.eventId },
			});
		case 'schedule_meet':
			return await queue(supa, userId, {
				kind: 'Calendar',
				summary: String(input.title),
				draft_content: (input.description as string | undefined) ?? null,
				action_type: 'schedule_meet',
				action_payload: {
					title: input.title,
					startTime: input.startTime,
					endTime: input.endTime,
					attendees: input.attendees ?? [],
					description: input.description ?? null,
				},
			});
		case 'list_tasks': {
			const token = await getFreshToken(supa, userId, 'tasks');
			if (!token) return NOT_CONNECTED('Tasks');
			return await tasksList(token);
		}
		case 'search_drive_files': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) return NOT_CONNECTED('Drive');
			return await driveSearchFiles(token, input.query as string | undefined, (input.maxResults as number) ?? 10);
		}
		case 'get_file_info': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) return NOT_CONNECTED('Drive');
			return await driveGetFileInfo(token, input.fileId as string);
		}
		case 'read_drive_file': {
			const token = await getFreshToken(supa, userId, 'drive');
			if (!token) return NOT_CONNECTED('Drive');
			return { content: await driveReadFileContent(token, input.fileId as string) };
		}
		case 'read_document': {
			const token = await getFreshToken(supa, userId, 'docs');
			if (!token) return NOT_CONNECTED('Docs');
			return { content: await driveReadFileContent(token, input.documentId as string) };
		}
		case 'read_sheet': {
			const token = await getFreshToken(supa, userId, 'sheets');
			if (!token) return NOT_CONNECTED('Sheets');
			return await sheetsRead(token, input.spreadsheetId as string, input.range as string | undefined);
		}
		case 'create_task':
			return await queue(supa, userId, {
				kind: 'Task',
				summary: String(input.title),
				draft_content: (input.description as string | undefined) ?? null,
				action_type: 'create_task',
				action_payload: { title: input.title, description: input.description ?? null, dueDate: input.dueDate ?? null },
			});
		case 'update_task':
			return await queue(supa, userId, {
				kind: 'Task',
				summary: `Update task: ${input.title ?? input.taskId}`,
				action_type: 'update_task',
				action_payload: {
					taskId: input.taskId,
					title: input.title,
					description: input.description,
					dueDate: input.dueDate,
					status: input.status,
				},
			});
		case 'complete_task':
			return await queue(supa, userId, {
				kind: 'Task',
				summary: 'Mark task complete',
				action_type: 'complete_task',
				action_payload: { taskId: input.taskId },
			});
		case 'create_folder':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: `New folder: ${input.name}`,
				action_type: 'create_folder',
				action_payload: { name: input.name, parentFolderId: input.parentFolderId ?? null },
			});
		case 'move_file':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: 'Move a file',
				action_type: 'move_file',
				action_payload: { fileId: input.fileId, targetFolderId: input.targetFolderId },
			});
		case 'rename_file':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: `Rename file to "${input.newName}"`,
				action_type: 'rename_file',
				action_payload: { fileId: input.fileId, newName: input.newName },
			});
		case 'delete_file':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: (input.permanently as boolean | undefined) ? 'Permanently delete a file' : 'Move a file to trash',
				action_type: 'delete_file',
				action_payload: { fileId: input.fileId, permanently: input.permanently ?? false },
			});
		case 'share_file':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: input.type === 'anyone' ? 'Share a file with anyone with the link' : `Share a file with ${(input.emailAddresses as unknown[] | undefined)?.length ?? 0} people`,
				action_type: 'share_file',
				action_payload: {
					fileId: input.fileId,
					emailAddresses: input.emailAddresses ?? [],
					role: input.role,
					type: input.type ?? 'user',
					sendNotification: input.sendNotification,
				},
			});
		case 'create_document':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: `New doc: ${input.title}`,
				draft_content: (input.content as string | undefined) ?? null,
				action_type: 'create_document',
				action_payload: { title: input.title, content: input.content ?? null, parentFolderId: input.parentFolderId ?? null },
			});
		case 'update_document':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: 'Update a doc',
				draft_content: input.content as string,
				action_type: 'update_document',
				action_payload: { documentId: input.documentId, mode: input.mode ?? 'append' },
			});
		case 'create_sheet':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: `New sheet: ${input.title}`,
				action_type: 'create_sheet',
				action_payload: { title: input.title, parentFolderId: input.parentFolderId ?? null },
			});
		case 'update_sheet':
			return await queue(supa, userId, {
				kind: 'Drive',
				summary: 'Update a sheet',
				action_type: 'update_sheet',
				action_payload: {
					spreadsheetId: input.spreadsheetId,
					sheetName: input.sheetName ?? null,
					range: input.range,
					values: input.values,
					mode: input.mode ?? 'overwrite',
				},
			});
		case 'create_standing_instruction': {
			const cadence = (input.cadence as string | undefined) ?? 'daily';
			const { data, error } = await supa.from('standing_instructions').insert({
				user_id: userId,
				goal_text: input.goal_text,
				trigger_type: 'cron',
				trigger_config: { cadence },
				status: 'active',
			}).select('id').single();
			if (error) throw new Error(error.message);
			return { created: true, id: data?.id };
		}
		case 'list_standing_instructions': {
			const { data, error } = await supa.from('standing_instructions')
				.select('id, goal_text, trigger_config, status, last_run_at, last_result')
				.eq('user_id', userId)
				.in('status', ['active', 'paused'])
				.order('created_at', { ascending: false });
			if (error) throw new Error(error.message);
			return data ?? [];
		}
		case 'cancel_standing_instruction': {
			const { error } = await supa.from('standing_instructions')
				.update({ status: 'cancelled' })
				.eq('id', input.id)
				.eq('user_id', userId);
			if (error) throw new Error(error.message);
			return { cancelled: true };
		}
		case 'queue_action':
			return await queue(supa, userId, {
				kind: input.kind as string,
				summary: input.summary as string,
				draft_content: input.draft_content as string | undefined,
				action_type: input.action_type as string,
				action_payload: (input.action_payload as Record<string, unknown>) ?? {},
			});
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

// Runs one inbound message through the loop; returns Alfy's reply text.
export async function runAgent(userId: string, message: string, history: Anthropic.MessageParam[] = []): Promise<string> {
	const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
	const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
	const messages: Anthropic.MessageParam[] = [...history, { role: 'user', content: message }];

	while (true) {
		const res = await anthropic.messages.create({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 1024,
			system: SYSTEM_PROMPT,
			tools: TOOLS,
			messages,
		});

		if (res.stop_reason !== 'tool_use') {
			return res.content.filter((b) => b.type === 'text').map((b) => (b as Anthropic.TextBlock).text).join('');
		}

		const results: Anthropic.ToolResultBlockParam[] = [];
		for (const block of res.content) {
			if (block.type === 'tool_use') {
				try {
					const out = await handleTool(block.name, block.input as Record<string, unknown>, supa, userId);
					results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
				} catch (err) {
					results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${(err as Error).message}`, is_error: true });
				}
			}
		}
		messages.push({ role: 'assistant', content: res.content });
		messages.push({ role: 'user', content: results });
	}
}
