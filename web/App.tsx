import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
	DeliverAs,
	LeechStatus,
	MediaAsset,
	ModelInfo,
	PromptResponse,
	SessionNode,
	SpawnRecord,
} from "../src/protocol.js";
import { ActivityFeed } from "./components/ActivityFeed";
import { PluginPanels } from "./components/PluginPanels";
import { LightboxModal } from "./components/LightboxModal";
import { NewSessionModal } from "./components/NewSessionModal";
import { PromptBar } from "./components/PromptBar";
import { SessionTree } from "./components/SessionTree";
import { SubagentRail } from "./components/SubagentRail";
import { ActivityBadge, StatusBadge } from "./components/StatusBadge";
import { useWebSocket } from "./hooks/useWebSocket";
import { sessionDescription, sessionName } from "./format";
import { navigate, useRoute } from "./router";

const REPO_URL = "https://github.com/luxuride-pi-extensions/pi-webapp";
const SPAWN_DISABLED_HINT =
	"This dashboard cannot start sessions — run the standalone daemon on loopback, or the primary pi instance";

const EXPAND_ALL_KEY = "pi-webapp:expand-all";

function readExpandAll(): boolean {
	try {
		return window.localStorage.getItem(EXPAND_ALL_KEY) === "1";
	} catch {
		return false;
	}
}

function defaultSession(sessions: SessionNode[]): SessionNode | null {
	const roots = sessions.filter(
		(session) => !session.isSubagent && (!session.parentSessionId || !sessions.some((p) => p.id === session.parentSessionId)),
	);
	return roots.find((session) => session.status === "running") ?? roots[0] ?? sessions[0] ?? null;
}

function relativeTime(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "";
	const seconds = Math.round((Date.now() - timestamp) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}

function elapsedTime(startedAt: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - startedAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function basename(filePath: string): string {
	const parts = filePath.split("/");
	return parts[parts.length - 1] ?? filePath;
}

function cwdBasename(cwd: string): string {
	const parts = cwd.split("/").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

interface TopBarProps {
	status: "connecting" | "open" | "closed";
	sessions: number;
	subagents: number;
	events: number;
	leech: LeechStatus | null;
	scanning: boolean;
	spawnEnabled: boolean;
	expandAll: boolean;
	onNewSession: () => void;
	onRescan: () => void;
	onToggleExpand: () => void;
	onToggleNav?: () => void;
}

function TopBar({
	status,
	sessions,
	subagents,
	events,
	leech,
	scanning,
	spawnEnabled,
	expandAll,
	onNewSession,
	onRescan,
	onToggleExpand,
	onToggleNav,
}: TopBarProps) {
	const live = status === "open";
	const dirs = leech?.dirs ?? [];
	return (
		<header class="flex items-center gap-3 border-b border-base-300 bg-base-200/80 px-3 py-1.5">
			{onToggleNav && (
				<button
					type="button"
					class="btn btn-ghost btn-square btn-sm -ml-1 md:hidden"
					onClick={onToggleNav}
					aria-label="Show sessions"
					data-testid="nav-toggle"
				>
					<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
						<path d="M2 4h12M2 8h12M2 12h12" stroke-linecap="round" />
					</svg>
				</button>
			)}
			<span class="text-meta font-semibold tracking-tight">pi-webapp</span>
			<span
				class="flex items-center gap-1.5 text-meta opacity-80"
				title={live ? "WebSocket connected" : "Reconnecting to the dashboard server"}
			>
				<span class={`size-1.5 rounded-full ${live ? "bg-success" : "bg-warning"}`} aria-hidden="true" />
				{live ? "live" : status === "connecting" ? "connecting" : "reconnecting"}
			</span>
			<span class="hidden items-center gap-1.5 font-mono text-meta opacity-82 md:flex" aria-label="Dashboard totals">
				<span>{sessions} sessions</span>
				<span aria-hidden="true">·</span>
				<span>
					{subagents} {subagents === 1 ? "subagent" : "subagents"}
				</span>
				<span aria-hidden="true">·</span>
				<span>{events} events</span>
				{leech && leech.sessions > 0 && (
					<span
						class="cursor-help"
						title={`${leech.sessions} leeched session file(s)\n${dirs.length > 0 ? dirs.join("\n") : "No leech directories configured"}`}
					>
						· {leech.sessions} leeched
					</span>
				)}
			</span>
			<div class="ml-auto flex shrink-0 items-center gap-2 pr-1">
				<span class="join shrink-0 rounded-lg border border-base-300/70 bg-base-200/40">
					<button
						type="button"
						class={`btn btn-square btn-sm join-item w-9 ${expandAll ? "btn-secondary" : "btn-ghost text-body-content/70"}`}
						onClick={onToggleExpand}
						aria-pressed={expandAll}
						aria-label={expandAll ? "Collapse everything" : "Expand all sessions, subagents and messages"}
						title={
							expandAll
								? "Expanded: subagents, thinking and tool output are open"
								: "Expand every session, subagent, thinking block and tool output"
						}
						data-testid="expand-all"
					>
						<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
							{expandAll ? (
								<path d="M6 3v10M3 6l3-3 3 3M10 13V3m3 7-3 3-3-3" stroke-linecap="round" stroke-linejoin="round" />
							) : (
								<path d="M6 10 3 13M10 6l3-3M3 10v3h3M13 6V3h-3" stroke-linecap="round" stroke-linejoin="round" />
							)}
						</svg>
					</button>
					<button
						type="button"
						class="btn btn-square btn-ghost btn-sm join-item"
						onClick={onRescan}
						disabled={scanning}
						aria-label="Rescan session files"
						title="Rescan session files for leeched sessions"
					>
						{scanning ? (
							<span class="loading loading-spinner loading-xs" />
						) : (
							<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
								<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5" stroke-linecap="round" stroke-linejoin="round" />
							</svg>
						)}
					</button>
					<a
						class="btn btn-square btn-ghost btn-sm join-item"
						href={REPO_URL}
						target="_blank"
						rel="noreferrer"
						aria-label="Open the pi-webapp repository"
						title="github.com/luxuride-pi-extensions/pi-webapp"
					>
						<svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7.5 8.5" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</a>
				</span>
				<button
					type="button"
					class="btn btn-primary btn-sm gap-1"
					onClick={onNewSession}
					disabled={!spawnEnabled}
					title={spawnEnabled ? "Start a new pi session in a working directory" : SPAWN_DISABLED_HINT}
				>
					<svg class="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
						<path d="M8 3.25v9.5M3.25 8h9.5" stroke-linecap="round" />
					</svg>
					New
				</button>
			</div>
		</header>
	);
}

interface SessionHeaderProps {
	session: SessionNode;
	onTakeOver?: (session: SessionNode) => void;
	onRemove?: (session: SessionNode) => void;
	onRename?: (session: SessionNode) => void;
	onSwitchModel?: (provider: string, modelId: string) => void;
	models?: ModelInfo[];
	takeoverBusy?: boolean;
	modelBusy?: boolean;
}

function SessionHeader({
	session,
	onTakeOver,
	onRemove,
	onRename,
	onSwitchModel,
	models = [],
	takeoverBusy = false,
	modelBusy = false,
}: SessionHeaderProps) {
	const name = sessionName(session);
	const canTakeOver =
		session.source === "leech" && !session.isSubagent && session.ownerPid !== undefined && !!onTakeOver;
	const busy = takeoverBusy || !!session.takeoverSpawnId;
	const subtitle = session.title && session.title !== name ? session.title : null;
	const currentModel = session.model ?? "";
	return (
		<div class="border-b border-base-300 bg-base-100 px-4 py-2 shadow-[0_6px_12px_-12px_rgba(0,0,0,0.9)]">
			<div class="flex min-w-0 items-center gap-2">
				<StatusBadge status={session.status} source={session.source} size="xs" />
				<ActivityBadge session={session} />
				<h1 class="min-w-0 truncate text-body font-semibold leading-tight" title={session.id}>
					{name}
				</h1>
				{subtitle && <span class="hidden min-w-0 truncate text-meta opacity-82 lg:inline">— {subtitle}</span>}
				<div class="ml-auto flex shrink-0 items-center gap-1">
					{canTakeOver && (
						<button
							type="button"
							class="btn btn-ghost btn-sm btn-square w-9 text-body-content/70"
							disabled={busy}
							onClick={() => onTakeOver?.(session)}
							aria-label="Take over this session"
							title="Resume this session in a new pi process and prompt it from here"
							data-testid="takeover-button"
						>
							{busy ? <span class="loading loading-spinner loading-xs" /> : <span aria-hidden="true">↻</span>}
						</button>
					)}
					{(onRename || onRemove) && (
						<details class="dropdown dropdown-end">
							<summary
								class="btn btn-square btn-ghost btn-xs list-none"
								aria-label="Session actions"
								title="Session actions"
								data-testid="session-actions"
							>
								<span aria-hidden="true">⋯</span>
							</summary>
							<ul class="menu dropdown-content z-30 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-1 text-meta shadow">
								{canTakeOver && (
									<li>
										<button
											type="button"
											class="justify-start"
											disabled={busy}
											onClick={() => onTakeOver?.(session)}
											title="Resume this session in a new pi process and prompt it from here"
											data-testid="takeover-menu"
										>
											{busy ? "Taking over…" : "Take over…"}
										</button>
									</li>
								)}
								{onRename && (
									<li>
										<button
											type="button"
											class="justify-start"
											onClick={() => onRename(session)}
											data-testid="rename-session"
										>
											Rename…
										</button>
									</li>
								)}
								{onRemove && (
									<li>
										<button
											type="button"
											class="justify-start text-error"
											onClick={() => onRemove(session)}
											data-testid="remove-session"
										>
											Remove session…
										</button>
									</li>
								)}
							</ul>
						</details>
					)}
				</div>
			</div>
			<div class="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-meta opacity-82">
				<span class="min-w-0 max-w-[24rem] truncate" title={session.cwd ?? ""}>
					{session.cwd ?? "—"}
				</span>
				{models.length > 0 && onSwitchModel && session.source !== "leech" ? (
					<label class="flex items-center gap-1" title="Switch the model for this session">
						<select
							class="select select-xs w-auto max-w-[15rem] border-base-300 font-mono text-meta"
							value={currentModel}
							disabled={modelBusy}
							onChange={(changeEvent) => {
								const [provider, ...rest] = String(changeEvent.currentTarget.value).split("/");
								const modelId = rest.join("/");
								if (provider && modelId) onSwitchModel(provider, modelId);
							}}
							data-testid="model-select"
						>
							{!currentModel && <option value="">choose model…</option>}
							{[...new Set(models.map((model) => model.provider))].map((provider) => (
								<optgroup key={provider} label={provider}>
									{models
										.filter((model) => model.provider === provider)
										.map((model) => (
											<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
												{model.name ?? model.id}
											</option>
										))}
								</optgroup>
							))}
						</select>
						{modelBusy && <span class="loading loading-spinner loading-xs" />}
					</label>
				) : (
					currentModel && <span class="truncate">{currentModel}</span>
				)}
				<span title={session.startedAt ? new Date(session.startedAt).toLocaleString() : undefined}>
					started {session.startedAt ? relativeTime(session.startedAt) : "—"}
				</span>
				{session.ownerPid !== undefined && (
					<span
						class={session.ownerBusy ? "text-warning" : ""}
						title={
							session.ownerBusy
								? `This session is busy in pi pid ${session.ownerPid}`
								: `This session is open in pi pid ${session.ownerPid}`
						}
					>
						pid {session.ownerPid}
					</span>
				)}
				<span class="ml-auto" title="Last activity">
					updated {relativeTime(session.updatedAt)}
				</span>
			</div>
		</div>
	);
}
interface StartingSpawnListProps {
	spawns: SpawnRecord[];
	onCancel: (spawnId: string) => void;
}

/** Compact list of dashboard-launched pi processes that have not registered a session yet. */
function StartingSpawnList({ spawns, onCancel }: StartingSpawnListProps) {
	const [now, setNow] = useState(() => Date.now());
	const active = spawns.length > 0;

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [active]);

	if (!active) return null;
	return (
		<section class="border-t border-base-300 p-2" aria-label="Starting sessions">
			<div class="flex items-center gap-1.5 px-1 pb-1 text-micro tracking-wide uppercase opacity-85">
				<span class="loading loading-spinner loading-xs" aria-hidden="true" />
				starting…
			</div>
			<ul class="flex flex-col gap-0.5">
				{spawns.map((spawn) => (
					<li key={spawn.spawnId} class="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-base-300/60">
						<div class="min-w-0 flex-1">
							<div class="truncate font-mono text-meta" title={spawn.cwd}>
								{cwdBasename(spawn.cwd)}
							</div>
							<div class="flex items-center gap-1.5 font-mono text-micro opacity-85">
								{typeof spawn.pid === "number" && <span>pid {spawn.pid}</span>}
								<span class="ml-auto">{elapsedTime(spawn.startedAt, now)}</span>
							</div>
						</div>
						<button
							type="button"
							class="btn btn-ghost btn-xs btn-square"
							title="Cancel this pi process"
							aria-label={`Cancel session in ${spawn.cwd}`}
							onClick={() => onCancel(spawn.spawnId)}
						>
							✕
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

export function App() {
	const {
		status,
		sessions,
		events,
		error,
		state,
		sendPrompt,
		rescanLeech,
		spawns,
		spawnEnabled,
		defaultCwd,
		startSession,
		stopSpawn,
		takeOverSession,
		removeSession,
		renameSession,
		switchModel,
	} = useWebSocket();
	const models = state?.models ?? [];
	const [modelBusyId, setModelBusyId] = useState<string | null>(null);
	const route = useRoute();
	const selectedId = route.view === "session" ? route.sessionId : null;
	const [navOpen, setNavOpen] = useState(false);
	const [lightbox, setLightbox] = useState<MediaAsset | null>(null);
	const [scanning, setScanning] = useState(false);
	const [modalOpen, setModalOpen] = useState(false);
	const [expandAll, setExpandAll] = useState(readExpandAll);
	const [takeoverTarget, setTakeoverTarget] = useState<SessionNode | null>(null);
	const [removeTarget, setRemoveTarget] = useState<SessionNode | null>(null);
	const [renameTarget, setRenameTarget] = useState<SessionNode | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [removeFile, setRemoveFile] = useState(false);
	const [removeBusy, setRemoveBusy] = useState(false);
	const [takeoverBusyId, setTakeoverBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const previousSelected = useRef<SessionNode | null>(null);
	const pendingSpawnId = useRef<string | null>(null);

	const selectSession = useCallback((id: string) => {
		navigate({ view: "session", sessionId: id });
		setNavOpen(false);
	}, []);

	const handleSwitchModel = useCallback(
		async (session: SessionNode, provider: string, modelId: string) => {
			setModelBusyId(session.id);
			const result = await switchModel(session.id, provider, modelId);
			setModelBusyId(null);
			if (!result.ok) setActionError(result.error ?? "the model could not be switched");
		},
		[switchModel],
	);

	const toggleExpand = useCallback(() => {
		setExpandAll((previous) => {
			const next = !previous;
			try {
				window.localStorage.setItem(EXPAND_ALL_KEY, next ? "1" : "0");
			} catch {
				/* private mode: keep it in memory only */
			}
			return next;
		});
	}, []);

	const selected = useMemo(
		() => (selectedId ? sessions.find((session) => session.id === selectedId) ?? null : null),
		[sessions, selectedId],
	);
	const trail = useMemo(() => {
		const chain: SessionNode[] = [];
		let current = selected;
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			chain.unshift(current);
			current = current.parentSessionId
				? sessions.find((session) => session.id === current?.parentSessionId) ?? null
				: null;
		}
		return chain;
	}, [sessions, selected]);

	useEffect(() => {
		if (selected) {
			previousSelected.current = selected;
			return;
		}
		if (sessions.length === 0) return;
		const previous = previousSelected.current;
		const previousParent = previous?.parentSessionId
			? sessions.find((session) => session.id === previous.parentSessionId) ?? null
			: null;
		const fallback = previousParent ?? defaultSession(sessions);
		// Replace so the first auto-selection does not create a stray history entry.
		if (fallback) navigate({ view: "session", sessionId: fallback.id }, { replace: true });
	}, [sessions, selected]);

	// A freshly spawned pi registers itself asynchronously; select it the moment it shows up.
	useEffect(() => {
		const pending = pendingSpawnId.current;
		if (!pending) return;
		const spawned = sessions.find((session) => session.spawnId === pending);
		if (!spawned) return;
		pendingSpawnId.current = null;
		selectSession(spawned.id);
	}, [sessions, selectSession]);

	const counts = useMemo(
		() => ({
			sessions: sessions.length,
			subagents: sessions.filter((session) => session.isSubagent).length,
			events: events.length,
		}),
		[sessions, events.length],
	);

	const handleSend = useCallback(
		(text: string, deliverAs: DeliverAs): Promise<PromptResponse> => {
			if (!selected) return Promise.resolve({ ok: false, error: "No session selected" });
			return sendPrompt(selected.id, text, deliverAs);
		},
		[selected, sendPrompt],
	);

	const handleRescan = useCallback(() => {
		setScanning(true);
		void rescanLeech().finally(() => setScanning(false));
	}, [rescanLeech]);

	const startingSpawns = useMemo(() => {
		const registered = new Set(sessions.map((session) => session.spawnId).filter((id): id is string => Boolean(id)));
		return spawns.filter(
			(spawn) => (spawn.status === "starting" || spawn.status === "running") && !registered.has(spawn.spawnId),
		);
	}, [spawns, sessions]);

	const openNewSession = useCallback(() => setModalOpen(true), []);
	const closeNewSession = useCallback(() => setModalOpen(false), []);
	const handleSpawned = useCallback(
		(spawn: SpawnRecord) => {
			const existing = sessions.find((session) => session.spawnId === spawn.spawnId);
			if (existing) {
				pendingSpawnId.current = null;
				selectSession(existing.id);
				return;
			}
			pendingSpawnId.current = spawn.spawnId;
		},
		[sessions, selectSession],
	);
	const handleStopSpawn = useCallback(
		(spawnId: string) => {
			void stopSpawn(spawnId);
		},
		[stopSpawn],
	);

	const handleTakeOver = useCallback(
		async (session: SessionNode) => {
			setActionError(null);
			setTakeoverBusyId(session.id);
			const result = await takeOverSession(session.id);
			setTakeoverBusyId(null);
			if (result.ok) {
				selectSession(session.id);
				return;
			}
			if (result.needsKill) {
				setTakeoverTarget(session);
				return;
			}
			setActionError(result.error ?? "Could not take over the session");
		},
		[takeOverSession, selectSession],
	);

	const confirmTakeOver = useCallback(async () => {
		const session = takeoverTarget;
		if (!session) return;
		setTakeoverTarget(null);
		setActionError(null);
		setTakeoverBusyId(session.id);
		const result = await takeOverSession(session.id, { kill: true });
		setTakeoverBusyId(null);
		if (result.ok) selectSession(session.id);
		else setActionError(result.error ?? "Could not take over the session");
	}, [takeoverTarget, takeOverSession, selectSession]);

	useEffect(() => {
		if (!takeoverTarget) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setTakeoverTarget(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [takeoverTarget]);

	const requestRename = useCallback((session: SessionNode) => {
		setRenameTarget(session);
		setRenameValue(sessionName(session));
	}, []);

	const confirmRename = useCallback(async () => {
		const session = renameTarget;
		if (!session) return;
		const result = await renameSession(session.id, renameValue);
		if (!result.ok) {
			setActionError(result.error ?? "could not rename the session");
			return;
		}
		setRenameTarget(null);
	}, [renameTarget, renameValue, renameSession]);

	const requestRemove = useCallback((session: SessionNode) => {
		setActionError(null);
		setRemoveFile(false);
		setRemoveTarget(session);
	}, []);

	const cancelRemove = useCallback(() => setRemoveTarget(null), []);

	const confirmRemove = useCallback(async () => {
		const session = removeTarget;
		if (!session) return;
		setRemoveBusy(true);
		const result = await removeSession(session.id, { deleteFile: removeFile });
		setRemoveBusy(false);
		setRemoveTarget(null);
		if (!result.ok) {
			setActionError(result.error ?? "Could not remove the session");
			return;
		}
		if (selectedId && result.removed?.includes(selectedId)) navigate({ view: "overview" }, { replace: true });
	}, [removeTarget, removeFile, removeSession, selectedId]);

	useEffect(() => {
		if (!removeTarget) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setRemoveTarget(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [removeTarget]);

	const closeLightbox = useCallback(() => setLightbox(null), []);
	const leech = state?.leech ?? null;

	return (
		<div data-testid="app-root" class="flex h-[100dvh] flex-col overflow-hidden bg-base-100 text-body-content">
			<TopBar
				status={status}
				sessions={counts.sessions}
				subagents={counts.subagents}
				events={counts.events}
				leech={leech}
				scanning={scanning}
				spawnEnabled={spawnEnabled}
				expandAll={expandAll}
				onNewSession={openNewSession}
				onRescan={handleRescan}
				onToggleExpand={toggleExpand}
				onToggleNav={() => setNavOpen((value) => !value)}
			/>
			<div class="relative flex min-h-0 flex-1">
				{navOpen && (
					<button
						type="button"
						class="absolute inset-0 z-20 bg-black/50 md:hidden"
						onClick={() => setNavOpen(false)}
						aria-label="Hide sessions"
					/>
				)}
				<aside
					class={`${
						navOpen ? "absolute inset-y-0 left-0 z-30 flex w-72 shadow-2xl" : "hidden"
					} shrink-0 flex-col overflow-y-auto border-r border-base-300 bg-base-200 md:relative md:z-auto md:flex md:w-80 md:shadow-none`}
				>
					<SessionTree
						sessions={sessions}
						selectedSessionId={selected?.id ?? null}
						onSelect={selectSession}
						spawns={spawns}
						onStopSpawn={handleStopSpawn}
						expandAll={expandAll}
						onExpandAllChange={setExpandAll}
						onTakeOver={handleTakeOver}
						takeoverBusyId={takeoverBusyId}
						onRemove={requestRemove}
						onRename={requestRename}
					/>
					<StartingSpawnList spawns={startingSpawns} onCancel={handleStopSpawn} />
				</aside>
				<main class="flex min-h-0 min-w-0 flex-1 flex-col">
					{(error || actionError) && (
						<div class="alert alert-warning mx-3 mt-2 py-1.5 text-meta" role="alert">
							<span class="min-w-0 flex-1 truncate">{actionError ?? error}</span>
							{actionError && (
								<button
									type="button"
									class="btn btn-ghost btn-xs"
									onClick={() => setActionError(null)}
									aria-label="Dismiss"
								>
									✕
								</button>
							)}
						</div>
					)}
					{selected ? (
						<>
							<SessionHeader
								session={selected}
								onTakeOver={handleTakeOver}
								onRemove={requestRemove}
								onRename={requestRename}
								onSwitchModel={(provider, modelId) => void handleSwitchModel(selected, provider, modelId)}
								models={models}
								modelBusy={modelBusyId === selected.id}
								takeoverBusy={takeoverBusyId === selected.id}
							/>
							{selected.isSubagent && (
							<nav
								aria-label="Breadcrumb"
								class="flex items-center gap-1 overflow-x-auto border-b border-base-300 bg-base-200/40 px-4 py-1 text-meta opacity-80"
								data-testid="breadcrumb"
							>
								<span class="shrink-0 opacity-85" aria-hidden="true">↳</span>
								{trail.map((node, index) => {
									const last = index === trail.length - 1;
									const label = sessionName(node);
									return (
										<span key={node.id} class="flex shrink-0 items-center gap-1.5">
											{index > 0 && <span class="opacity-85">/</span>}
											{last ? (
												<span class="font-medium opacity-100" aria-current="page">
													{label}
												</span>
											) : (
												<button
													type="button"
													class="link link-hover max-w-[14rem] truncate"
													onClick={() => selectSession(node.id)}
													title={node.title ?? node.id}
												>
													{label}
												</button>
											)}
										</span>
									);
								})}
							</nav>
							)}
							<PluginPanels plugins={state?.plugins ?? []} session={selected} events={events} expandAll={expandAll} />
							<div class="flex min-h-0 flex-1">
								<div class="min-h-0 min-w-0 flex-1">
									<ActivityFeed
										expandAll={expandAll}
										events={events}
										sessions={sessions}
										selected={selected}
										onSelectSession={selectSession}
										onOpenImage={setLightbox}
									/>
								</div>
								{sessions.some((node) => node.parentSessionId === selected.id) && (
									<SubagentRail
										session={selected}
										sessions={sessions}
										events={events}
										onSelect={selectSession}
									/>
								)}
							</div>
						</>
					) : (
						<div class="flex flex-1 items-center justify-center p-8">
							<div class="alert alert-info max-w-md">
								<span>
									No session selected. Start a pi session with the pi-webapp extension, or enable the leech
									watcher to tail existing transcripts.
								</span>
							</div>
						</div>
					)}
					<PromptBar
						target={selected}
						onSend={handleSend}
						onTakeOver={handleTakeOver}
						takingOver={takeoverBusyId === selected?.id}
					/>
				</main>
			</div>
			{renameTarget && (
				<div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="rename-title">
					<div class="modal-box max-w-md border border-base-300">
						<h3 id="rename-title" class="text-body font-semibold">
							Rename session
						</h3>
						<p class="py-2 text-meta opacity-85">
							Only the dashboard label changes. The agent name and the transcript stay untouched — clear the field to
							reset.
						</p>
						<input
							class="input input-sm w-full border-base-300 bg-base-200"
							value={renameValue}
							maxLength={80}
							placeholder="e.g. checkout-flow"
							onInput={(event) => setRenameValue((event.target as HTMLInputElement).value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void confirmRename();
								if (event.key === "Escape") setRenameTarget(null);
							}}
							data-testid="rename-input"
							autoFocus
						/>
						<div class="modal-action">
							<button type="button" class="btn btn-ghost btn-sm" onClick={() => setRenameTarget(null)}>
								Cancel
							</button>
							<button
								type="button"
								class="btn btn-primary btn-sm"
								onClick={() => void confirmRename()}
								data-testid="rename-confirm"
							>
								Save name
							</button>
						</div>
					</div>
					<button
						type="button"
						class="modal-backdrop bg-black/50"
						aria-label="Close"
						onClick={() => setRenameTarget(null)}
					/>
				</div>
			)}
			{takeoverTarget && (
				<div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="takeover-title">
					<div class="modal-box max-w-md border border-base-300">
						<h3 id="takeover-title" class="text-body font-semibold">
							Take over this session?
						</h3>
						<p class="py-2 text-body opacity-80">
							{sessionDescription(takeoverTarget)} is still open in pi pid {takeoverTarget.ownerPid}. Stopping that pi
							process and resuming the session in a new one lets you prompt it from the dashboard.
						</p>
						<p class="rounded-md bg-base-200 px-2 py-1 font-mono text-meta opacity-80">
							pi --session {takeoverTarget.sessionFile ?? takeoverTarget.id}
						</p>
						<div class="modal-action">
							<button type="button" class="btn btn-ghost btn-sm" onClick={() => setTakeoverTarget(null)}>
								Cancel
							</button>
							<button
								type="button"
								class="btn btn-error btn-sm"
								onClick={() => void confirmTakeOver()}
								data-testid="takeover-confirm"
							>
								Stop pi and take over
							</button>
						</div>
					</div>
					<button
						type="button"
						class="modal-backdrop bg-black/50"
						aria-label="Close"
						onClick={() => setTakeoverTarget(null)}
					/>
				</div>
			)}
			{removeTarget && (
				<div class="modal modal-open" role="dialog" aria-modal="true" aria-labelledby="remove-title">
					<div class="modal-box max-w-md border border-base-300">
						<h3 id="remove-title" class="text-body font-semibold">
							Remove session?
						</h3>
						<p class="py-2 text-body opacity-80">
							{sessionDescription(removeTarget)} disappears from the dashboard
							{removeTarget.parentSessionId ? "" : " together with its subagents"}.
							{removeTarget.spawnId ? " Its pi process is stopped." : ""}
						</p>
						<label class="label cursor-pointer justify-start gap-2 rounded-md bg-base-200 px-2 py-1.5">
							<input
								type="checkbox"
								class="checkbox checkbox-sm checkbox-error"
								checked={removeFile}
								onChange={(event) => setRemoveFile((event.target as HTMLInputElement).checked)}
								data-testid="remove-file"
							/>
							<span class="text-meta">
								Also delete the transcript file
								<span class="ml-1 font-mono opacity-80">
									{removeTarget.sessionFile ? basename(removeTarget.sessionFile) : "—"}
								</span>
							</span>
						</label>
						<div class="modal-action">
							<button type="button" class="btn btn-ghost btn-sm" onClick={cancelRemove} disabled={removeBusy}>
								Cancel
							</button>
							<button
								type="button"
								class="btn btn-error btn-sm"
								onClick={() => void confirmRemove()}
								disabled={removeBusy}
								data-testid="remove-confirm"
							>
								{removeBusy && <span class="loading loading-spinner loading-xs" />}
								Remove
							</button>
						</div>
					</div>
					<button
						type="button"
						class="modal-backdrop bg-black/50"
						aria-label="Close"
						onClick={cancelRemove}
					/>
				</div>
			)}
			<LightboxModal asset={lightbox} onClose={closeLightbox} />
			<NewSessionModal
				open={modalOpen}
				defaultCwd={defaultCwd}
				startSession={startSession}
				onSpawned={handleSpawned}
				onClose={closeNewSession}
			/>
		</div>
	);
}
