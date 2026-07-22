import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// The /auth/google-callback landing. Google redirects here with ?code=&state=google
// after consent (one screen covers every Google scope Alfy's tools use); this hands the
// code to alfy-connect, which exchanges it for tokens.

export default function GoogleCallback() {
	const [msg, setMsg] = useState('Connecting…');

	useEffect(() => {
		(async () => {
			const params = new URLSearchParams(window.location.search);
			const code = params.get('code');
			if (!code) return void window.location.replace('/app');
			if (!supabase) return setMsg("Sign-in isn't switched on yet.");

			const { data: { session } } = await supabase.auth.getSession();
			if (!session) return void window.location.replace('/login');

			const redirect_uri = `${window.location.origin}/auth/google-callback`;
			const { error } = await supabase.functions.invoke('alfy-connect', {
				body: { code, redirect_uri },
			});

			window.location.replace(error ? '/app?connect_failed=1' : '/app?connected=google');
		})();
	}, []);

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6">
			<span className="font-display text-h1 font-semibold text-espresso">Alfy</span>
			<p className="text-body text-secondary">{msg}</p>
		</div>
	);
}
