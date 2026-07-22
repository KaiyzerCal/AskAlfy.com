// Twilio signature validation + send, hand-rolled and live-tested in PrymalAI-dashboard.
// Ported in place of AskAlfy's previous TODO(VERIFY) stub.

const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER')!;

export const TWILIO_FROM_NUMBER = TWILIO_FROM;

// Twilio: signature = base64(HMAC-SHA1(url + sorted-concatenated POST params, auth token)).
// Supabase terminates TLS, so the public URL Twilio actually signed has to be reconstructed.
export async function validateTwilioSignature(req: Request, params: Record<string, string>): Promise<boolean> {
	const signature = req.headers.get('x-twilio-signature');
	if (!signature || !TWILIO_TOKEN) return false;

	const url = new URL(req.url);
	const publicUrl = `https://${url.host}${url.pathname}${url.search}`;
	const sorted = Object.keys(params).sort().map((k) => k + params[k]).join('');
	const data = publicUrl + sorted;

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(TWILIO_TOKEN),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
	return expected === signature;
}

const MAX_SEGMENT_CHARS = 1500;
const MAX_SEGMENTS = 3;

function chunkBody(body: string): string[] {
	if (body.length <= MAX_SEGMENT_CHARS) return [body];
	const chunks: string[] = [];
	for (let i = 0; i < body.length && chunks.length < MAX_SEGMENTS; i += MAX_SEGMENT_CHARS) {
		chunks.push(body.slice(i, i + MAX_SEGMENT_CHARS));
	}
	return chunks;
}

// Splits long replies into up to 3 SMS segments as a safety net — the system prompt
// already asks Alfy to keep replies to 5 lines, so this should rarely trigger.
export async function sendSms(to: string, body: string): Promise<boolean> {
	for (const chunk of chunkBody(body)) {
		const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
			method: 'POST',
			headers: {
				Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: chunk }),
		});
		if (!res.ok) return false;
	}
	return true;
}
