// alfy-agent — deployable home for the brain, which now actually lives in
// _shared/agent.ts so alfy-sms-inbound can import runAgent without relying on
// Supabase's per-folder function bundling. This entrypoint re-exports it and serves
// a no-op health response; nothing calls this function over HTTP today.
import { runAgent } from '../_shared/agent.ts';

export { runAgent };

Deno.serve(() => new Response('alfy-agent: shared module, invoked internally by alfy-sms-inbound.', { status: 200 }));
