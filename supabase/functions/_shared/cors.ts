// Reflect the caller's origin instead of a strict allowlist. These endpoints already
// authenticate via Bearer JWT or a Twilio/shared-secret check, so origin is
// defense-in-depth, not the real gate — a strict allowlist just produces a silent
// "Failed to fetch" in the browser for any origin not on it, with no useful signal.
export function corsHeaders(req: Request): Record<string, string> {
	const origin = req.headers.get('origin') ?? '*';
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Headers': 'authorization, content-type',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
	};
}
