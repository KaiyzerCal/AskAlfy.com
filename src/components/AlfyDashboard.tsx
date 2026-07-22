import { useEffect, useState } from 'react';
import {
	DEMO_QUEUE,
	DEMO_HANDLED,
	DEMO_PEOPLE,
	DEMO_TRUST,
	loadToday,
	loadHandled,
	loadPeople,
	loadTrust,
	revokeTrust,
	approveItem,
	skipItem,
	connectGoogle,
	loadBilling,
	startCheckout,
	breakdown,
	type QueueItem,
	type HandledItem,
	type PersonItem,
	type TrustItem,
	type Range,
	type BillingStatus,
} from '../lib/queue';

// Reads Supabase when configured (src/lib/supabase.ts); otherwise renders demo data.

type Tab = 'today' | 'handled' | 'knows';

const WATCHING = [
	'Wifi bill is due Friday — reminder set for Thursday morning',
	'Airline refund from March — checking daily, day 6',
];

const reduceMotion =
	typeof window !== 'undefined' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function trialDaysLeft(trialEndsAt: string): number {
	return Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000));
}

const PLAN_LABEL: Record<BillingStatus['plan'], string> = {
	trial: 'Free trial',
	active: 'Alfy — $25/mo',
	plus: 'Alfy Plus — $75/mo',
	past_due: 'Your plan needs attention',
	canceled: 'Your plan ended',
};

const tabClass = (active: boolean) =>
	`cursor-pointer px-4 py-2.5 text-small font-medium -mb-px border-b-2 transition-colors ${
		active
			? 'text-espresso border-marigold'
			: 'text-secondary border-transparent hover:text-espresso'
	}`;

function QueueCard({
	item,
	onApprove,
	onSkip,
}: {
	item: QueueItem;
	onApprove: (item: QueueItem, draft: string) => void;
	onSkip: (id: string | number) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(item.draft);
	const [state, setState] = useState<'active' | 'approved' | 'leaving'>('active');

	function approve() {
		setState('approved');
		window.setTimeout(() => onApprove(item, draft), reduceMotion ? 0 : 650);
	}

	function skip() {
		setState('leaving');
		window.setTimeout(() => onSkip(item.id), reduceMotion ? 0 : 300);
	}

	return (
		<div
			className={`q-card card-lift rounded-3xl border bg-card p-5 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)] ${
				state === 'approved' ? 'border-fern/30' : 'border-hairline'
			}`}
			style={{
				transition: reduceMotion ? undefined : 'opacity .3s, transform .3s',
				opacity: state === 'leaving' ? 0 : 1,
				transform: state === 'leaving' ? 'translateY(-8px)' : undefined,
			}}
		>
			<p className="label-caps text-muted">{item.kind}</p>
			<h2 className="mt-2 font-display text-h2 font-medium">{item.summary}</h2>

			{editing ? (
				<textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					rows={3}
					autoFocus
					className="mt-2 w-full resize-none rounded-2xl border border-hairline bg-linen px-4 py-3 text-body text-espresso focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso"
				/>
			) : (
				<p className="mt-2 rounded-2xl border border-hairline bg-linen px-4 py-3 text-body text-secondary">
					{draft}
				</p>
			)}

			<div className="mt-4 flex gap-2">
				<button
					type="button"
					onClick={approve}
					disabled={state !== 'active'}
					className={`min-h-11 cursor-pointer rounded-full px-5 text-small font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:cursor-default ${
						state === 'approved'
							? 'bg-fern text-on-fern'
							: 'bg-marigold text-on-marigold hover:bg-[#C97923]'
					}`}
				>
					{state === 'approved' ? 'Approved' : 'Approve'}
				</button>
				<button
					type="button"
					onClick={() => setEditing((e) => !e)}
					disabled={state !== 'active'}
					className="min-h-11 cursor-pointer rounded-full border border-hairline px-5 text-small font-medium text-espresso transition-colors hover:bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:opacity-40"
				>
					{editing ? 'Done' : 'Edit'}
				</button>
				<button
					type="button"
					onClick={skip}
					disabled={state !== 'active'}
					className="min-h-11 cursor-pointer rounded-full px-5 text-small font-medium text-secondary transition-colors hover:bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso disabled:opacity-40"
				>
					Skip
				</button>
			</div>
		</div>
	);
}

export default function AlfyDashboard() {
	const [tab, setTab] = useState<Tab>('today');
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [queue, setQueue] = useState<QueueItem[]>(DEMO_QUEUE);
	const [handled, setHandled] = useState<HandledItem[]>(DEMO_HANDLED);
	const [range, setRange] = useState<Range>('week');
	const [people, setPeople] = useState<PersonItem[]>(DEMO_PEOPLE);
	const [trust, setTrust] = useState<TrustItem[]>(DEMO_TRUST);
	const [billing, setBilling] = useState<BillingStatus | null>(null);

	// Hydrate from Supabase when it's configured; demo data shows until then.
	useEffect(() => {
		loadToday().then(setQueue);
	}, []);
	useEffect(() => {
		loadHandled(range).then(setHandled);
	}, [range]);
	useEffect(() => {
		loadPeople().then(setPeople);
		loadTrust().then(setTrust);
	}, []);
	useEffect(() => {
		loadBilling().then(setBilling);
	}, []);

	function handleRevokeTrust(id: string | number) {
		setTrust((t) => t.filter((i) => i.id !== id));
		void revokeTrust(id);
	}

	function handleApprove(item: QueueItem) {
		setQueue((q) => q.filter((i) => i.id !== item.id));
		setHandled((h) => [
			{ id: Date.now(), kind: item.kind, what: item.summary, when: 'you approved, just now', undo: true, standing: false },
			...h,
		]);
		void approveItem(item.id);
	}

	function handleSkip(id: string | number) {
		setQueue((q) => q.filter((i) => i.id !== id));
		void skipItem(id);
	}

	function undo(id: string | number) {
		setHandled((h) => h.filter((i) => i.id !== id));
	}

	function selectTab(next: Tab) {
		setTab(next);
		setSettingsOpen(false);
	}

	return (
		<div className="min-h-dvh">
			<header className="border-b border-hairline bg-card">
				<div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
					<div className="flex items-center gap-3">
						<a
							href="/"
							aria-label="Back to the homepage"
							className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-hairline text-secondary transition-colors hover:bg-linen hover:text-espresso focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso"
						>
							<svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
								<path
									d="M10 3 5 8l5 5"
									stroke="currentColor"
									strokeWidth="1.8"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</a>
						<a href="/" className="font-display text-h2 font-semibold text-espresso">
							AskAlfy
						</a>
					</div>
					<button
						type="button"
						onClick={() => setSettingsOpen((s) => !s)}
						aria-expanded={settingsOpen}
						aria-controls="settings"
						className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-secondary transition-colors hover:bg-linen focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso"
						aria-label="Settings"
					>
						<svg
							className="h-5 w-5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.8"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
					</button>
				</div>
				<nav className="mx-auto max-w-3xl px-6" aria-label="Screens">
					<div className="flex gap-1">
						<button type="button" className={tabClass(tab === 'today')} onClick={() => selectTab('today')}>
							Today
						</button>
						<button type="button" className={tabClass(tab === 'handled')} onClick={() => selectTab('handled')}>
							Handled
						</button>
						<button type="button" className={tabClass(tab === 'knows')} onClick={() => selectTab('knows')}>
							Alfy knows
						</button>
					</div>
				</nav>
			</header>

			<p className="mx-auto mt-6 flex max-w-3xl flex-wrap items-center gap-3 px-6">
				<span className="rounded-full border border-hairline bg-card px-3 py-1 text-small text-muted">
					Example data — this is the web view your texts come with
				</span>
			</p>

			<main className="mx-auto max-w-3xl px-6 py-8">
				{tab === 'today' && (
					<section className="space-y-6">
						<div className="rounded-3xl border border-hairline bg-card p-6 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)]">
							<p className="label-caps text-muted">The brief</p>
							<p className="mt-3 text-body text-espresso">
								{queue.length > 0 ? (
									<>
										Morning. {queue.length === 1 ? 'One thing needs' : `${queue.length} things need`} your
										yes, and I'm watching two more. Nothing's urgent before noon.
									</>
								) : (
									<>You're clear. Nothing needs your yes right now — I'm still watching two things.</>
								)}
								<br />
								<span className="text-secondary">— A</span>
							</p>
						</div>

						<div className="space-y-4">
							{queue.map((item) => (
								<QueueCard key={item.id} item={item} onApprove={handleApprove} onSkip={handleSkip} />
							))}
						</div>

						<div className="rounded-3xl border border-hairline bg-card p-6">
							<p className="label-caps text-muted">Watching</p>
							<ul className="mt-3 space-y-2">
								{WATCHING.map((w) => (
									<li key={w} className="text-body text-secondary">
										{w}
									</li>
								))}
							</ul>
						</div>
					</section>
				)}

				{tab === 'handled' && (() => {
					const b = breakdown(handled);
					const rangeLabel = range === 'week' ? 'This week' : range === 'lastweek' ? 'Last week' : 'Everything';
					return (
					<section className="space-y-6">
						<div className="flex items-center justify-between">
							<p className="text-body text-secondary">{rangeLabel}</p>
							<label>
								<span className="sr-only">Time range</span>
								<select
									value={range}
									onChange={(e) => setRange(e.target.value as Range)}
									className="cursor-pointer rounded-full border border-hairline bg-card py-1.5 pl-4 pr-8 text-small text-espresso focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso"
								>
									<option value="week">This week</option>
									<option value="lastweek">Last week</option>
									<option value="all">Everything</option>
								</select>
							</label>
						</div>

						{/* The breakdown — the Sunday digest on a screen. A receipt, not a chart. */}
						<div className="rounded-3xl border border-hairline bg-card p-6 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)]">
							<p className="font-display text-h2 font-medium text-espresso">
								Alfy handled {b.total} {b.total === 1 ? 'thing' : 'things'} for you.
							</p>
							{b.total > 0 && (
								<>
									<p className="mt-2 text-body text-secondary">
										{b.byKind.map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ')}
									</p>
									<p className="mt-1 text-small text-muted">
										{b.approved} you approved · {b.standing} standing okay{b.standing === 1 ? '' : 's'} · ~{b.hoursSaved} hrs saved
									</p>
								</>
							)}
						</div>

						<div className="rounded-3xl border border-hairline bg-card p-6 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)]">
							<ul className="divide-y divide-hairline">
								{handled.map((row) => (
									<li key={row.id} className="flex items-start gap-3 py-4">
										<span
											className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fern-tint text-fern"
											aria-hidden="true"
										>
											<svg className="h-3 w-3" viewBox="0 0 16 16" fill="none">
												<path
													d="M3 8.5 6.5 12 13 4.5"
													stroke="currentColor"
													strokeWidth="2.5"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										</span>
										<div className="flex-1">
											<p className="text-body text-espresso">{row.what}</p>
											<p className="text-small text-muted">{row.when}</p>
										</div>
										{row.undo && (
											<button
												type="button"
												onClick={() => undo(row.id)}
												className="cursor-pointer text-small font-medium text-fern underline decoration-fern/40 underline-offset-4 hover:text-espresso"
											>
												undo
											</button>
										)}
									</li>
								))}
							</ul>
						</div>
						<p className="text-small text-muted">This is the same view Alfy's Sunday text links to.</p>
					</section>
					);
				})()}

				{tab === 'knows' && (
					<section className="space-y-6">
						<div className="rounded-3xl border border-hairline bg-card p-6 shadow-[0_8px_30px_-12px_rgba(46,42,36,0.12)]">
							<p className="label-caps text-muted">People</p>
							<ul className="mt-3 divide-y divide-hairline">
								{people.map((p) => (
									<li key={p.id} className="flex items-baseline justify-between gap-4 py-3">
										<p className="text-body text-espresso">
											<span className="font-medium">{p.name}</span>
											<span className="text-secondary"> — {p.note}</span>
										</p>
										<button
											type="button"
											className="cursor-pointer text-small font-medium text-secondary underline decoration-hairline underline-offset-4 hover:text-espresso"
										>
											edit
										</button>
									</li>
								))}
							</ul>
						</div>

						<div className="rounded-3xl border border-fern/20 bg-fern-tint/40 p-6">
							<p className="label-caps text-fern">Trust</p>
							<ul className="mt-3 space-y-3">
								{trust.map((t) => (
									<li key={t.id} className="text-body text-espresso">
										{t.line}
										<span className="text-secondary"> — {t.since} · </span>
										<button
											type="button"
											onClick={() => handleRevokeTrust(t.id)}
											className="cursor-pointer text-small font-medium text-fern underline decoration-fern/40 underline-offset-4 hover:text-espresso"
										>
											revoke
										</button>
									</li>
								))}
								<li className="text-body text-secondary">Everything else waits for your yes.</li>
							</ul>
						</div>

						<div className="rounded-3xl border border-hairline bg-card p-6">
							<label htmlFor="about" className="label-caps text-muted">
								Tell Alfy about yourself
							</label>
							<textarea
								id="about"
								rows={3}
								className="mt-3 w-full resize-none rounded-2xl border border-hairline bg-linen px-4 py-3 text-body text-espresso placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-espresso"
								placeholder="Plain words. Anything that helps — who matters, what you always forget, how you like things done."
							/>
						</div>
					</section>
				)}

				{settingsOpen && (
					<section
						id="settings"
						className="mt-8 rounded-3xl border border-hairline bg-card p-6"
						aria-label="Settings"
					>
						<p className="label-caps text-muted">Settings</p>
						<ul className="mt-3 divide-y divide-hairline text-body">
							<li className="flex items-center justify-between py-3">
								<span className="text-espresso">Connections</span>
								<button
									type="button"
									onClick={() => connectGoogle()}
									className="cursor-pointer text-small font-medium text-fern underline decoration-fern/40 underline-offset-4 hover:text-espresso"
								>
									Connect Google
								</button>
							</li>
							<li className="flex items-center justify-between py-3">
								<div>
									<span className="text-espresso">Billing</span>
									{billing && (
										<p className="text-small text-muted">
											{billing.plan === 'trial' && billing.trialEndsAt
												? `${trialDaysLeft(billing.trialEndsAt)} day${trialDaysLeft(billing.trialEndsAt) === 1 ? '' : 's'} left in your free trial`
												: PLAN_LABEL[billing.plan]}
										</p>
									)}
								</div>
								{billing ? (
									billing.plan === 'active' || billing.plan === 'plus' ? (
										<button
											type="button"
											onClick={() => void startCheckout()}
											className="cursor-pointer text-small font-medium text-secondary hover:text-espresso"
										>
											Manage
										</button>
									) : (
										<button
											type="button"
											onClick={() => void startCheckout()}
											className="min-h-9 cursor-pointer rounded-full bg-marigold px-4 text-small font-medium text-on-marigold transition-colors hover:bg-[#C97923]"
										>
											{billing.plan === 'past_due' || billing.plan === 'canceled' ? 'Reactivate' : 'Upgrade'}
										</button>
									)
								) : (
									<span className="text-small text-secondary">manage</span>
								)}
							</li>
							<li className="flex items-center justify-between py-3">
								<span className="text-espresso">Quiet hours</span>
								<span className="text-small text-secondary">9pm – 7am</span>
							</li>
							<li className="flex items-center justify-between py-3">
								<span className="text-espresso">Export everything</span>
								<span className="text-small text-secondary">one file, yours</span>
							</li>
							<li className="flex items-center justify-between py-3">
								<span className="text-espresso">Cancel</span>
								<span className="text-small text-secondary">one click, or just text "cancel"</span>
							</li>
						</ul>
					</section>
				)}
			</main>
		</div>
	);
}
