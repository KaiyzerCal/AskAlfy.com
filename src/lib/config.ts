// Placeholder until a real number is provisioned — update here once and every
// CTA (hero, footer, QR code) picks it up.
export const ALFY_PHONE = '+10000000000';
export const SMS_URI = `sms:${ALFY_PHONE}`;

// Google OAuth client ID is public (not a secret) — the matching GOOGLE_CLIENT_SECRET
// lives only as an edge-function secret. Placeholder until a real GCP OAuth client is
// created (see docs/alfy-handoff.md); the redirect URI to register there is
// `${PUBLIC_APP_URL}/auth/google-callback`.
export const GOOGLE_CLIENT_ID = 'REPLACE_WITH_REAL_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

// One "Connect Google" button asks for every scope Alfy's tools use in a single consent
// screen, rather than a separate OAuth round-trip per Google app — simpler for an SMS-first
// product with one Settings row, not a per-integration dashboard. drive.file only grants
// access to files this app created or the person opened with it (see docs/alfy-handoff.md).
export const GOOGLE_SCOPES: string[] = [
	'https://www.googleapis.com/auth/gmail.modify',
	'https://www.googleapis.com/auth/gmail.send',
	'https://www.googleapis.com/auth/gmail.settings.basic',
	'https://www.googleapis.com/auth/calendar',
	'https://www.googleapis.com/auth/tasks',
	'https://www.googleapis.com/auth/drive.file',
	'https://www.googleapis.com/auth/documents',
	'https://www.googleapis.com/auth/spreadsheets',
];
