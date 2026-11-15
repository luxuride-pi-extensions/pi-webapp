import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DeliverAs, LeechStatus, MediaAsset, PromptResponse, SessionNode } from "../src/protocol.js";
import { ActivityFeed } from "./components/ActivityFeed";
import { LightboxModal } from "./components/LightboxModal";
import { PromptBar } from "./components/PromptBar";
import { SessionTree } from "./components/SessionTree";
import { StatusBadge } from "./components/StatusBadge";
import { useWebSocket } from "./hooks/useWebSocket";

const REPO_URL = "https://github.com/luxuride-pi-extensions/pi-wabapp";

function readSessionHash(): string | null {
	const match = /(?:^|[#&])session=([^&]+)/.exec(window.location.hash);
	if (!match) return null;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
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

interface TopBarProps {
	status: "connecting" | "open" | "closed";
	sessions: number;
	subagents: number;
	events: number;
	leech: LeechStatus | null;
	scanning: boolean;
	onRescan: () => void;
}

function TopBar({ status, sessions, subagents, events, leech, scanning, onRescan }: TopBarProps) {
	const live = status === "open";
	const dirs = leech?.dirs ?? [];
	return (
		<header class="flex flex-wrap items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2">
			<div class="flex items-baseline gap-2">
				<span class="text-base font-semibold tracking-tight">pi-wabapp</span>
				<span class="hidden text-[11px] opacity-50 sm:inline">live agent session dashboard</span>
			</div>
			<div class="flex items-center gap-1.5 text-xs" title={live ? "WebSocket connected" : "Reconnecting to the dashboard server"}>
				<span class={`size-2 rounded-full ${live ? "bg-success" : "bg-warning animate-pulse"}`} aria-hidden="true" />
				<span class="opacity-70">{live ? "live" : status === "connecting" ? "connecting" : "reconnecting"}</span>
			</div>
			<div class="flex items-center gap-1 font-mono text-[11px]">
				<span class="badge badge-ghost badge-sm">sessions {sessions}</span>
				<span class="badge badge-ghost badge-sm">subagents {subagents}</span>
				<span class="badge badge-ghost badge-sm">events {events}</span>
			</div>
			{leech && leech.sessions > 0 && (
				<div
					class="tooltip tooltip-bottom"
					data-tip={dirs.length > 0 ? dirs.join("\n") : "No leech directories configured"}
				>
					<span class="badge badge-info badge-sm cursor-help">leech {leech.sessions}</span>
				</div>
			)}
			<div class="ml-auto flex items-center gap-1">
				<button type="button" class="btn btn-ghost btn-xs" onClick={onRescan} disabled={scanning}>
					{scanning && <span class="loading loading-spinner loading-xs" />}
					Rescan
				</button>
				<a class="btn btn-ghost btn-xs" href={REPO_URL} target="_blank" rel="noreferrer">
					repo ↗
				</a>
			</div>
		</header>
	);
}

interface SessionHeaderProps {
	session: SessionNode;
	parent: SessionNode | null;
	onSelect: (id: string) => void;
}

function SessionHeader({ session, parent, onSelect }: SessionHeaderProps) {
	const name = session.agentName ?? "session";
	return (
		<div class="border-b border-base-300 bg-base-100 px-4 py-3">
			<div class="card card-border border-base-300 bg-base-200/50">
				<div class="card-body gap-1 p-3">
					<div class="flex flex-wrap items-center gap-2">
						<h1 class="text-base font-semibold">{name}</h1>
						<StatusBadge status={session.status} source={session.source} size="sm" />
						{session.isSubagent && (
							<span class="badge badge-secondary badge-outline badge-sm">
								subagent of {parent?.agentName ?? "parent"}
							</span>
						)}
						<span class="ml-auto font-mono text-[11px] opacity-50">
							updated {relativeTime(session.updatedAt)}
						</span>
					</div>
					{session.title && (
						<p class="truncate text-sm opacity-70" title={session.title}>
							{session.title}
						</p>
					)}
					<div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] opacity-60">
						<span class="truncate" title={session.cwd ?? ""}>
							cwd {session.cwd ?? "—"}
						</span>
						<span>model {session.model ?? "—"}</span>
						<span>started {session.startedAt ? relativeTime(session.startedAt) : "—"}</span>
						{session.isSubagent && parent && (
							<button type="button" class="link link-primary" onClick={() => onSelect(parent.id)}>
								← Back to Parent
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

export function App() {
	const { status, sessions, events, error, state, sendPrompt, rescanLeech } = useWebSocket();
	const [selectedId, setSelectedId] = useState<string | null>(readSessionHash);
	const [lightbox, setLightbox] = useState<MediaAsset | null>(null);
	const [scanning, setScanning] = useState(false);
	const previousSelected = useRef<SessionNode | null>(null);

	const selectSession = useCallback((id: string) => {
		setSelectedId(id);
		const nextHash = `#session=${encodeURIComponent(id)}`;
		if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
	}, []);

	const selected = useMemo(
		() => (selectedId ? sessions.find((session) => session.id === selectedId) ?? null : null),
		[sessions, selectedId],
	);
	const parent = useMemo(
		() => (selected?.parentSessionId ? sessions.find((session) => session.id === selected.parentSessionId) ?? null : null),
		[sessions, selected],
	);

	useEffect(() => {
		const onHashChange = () => setSelectedId(readSessionHash());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

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
		if (fallback) selectSession(fallback.id);
	}, [sessions, selected, selectSession]);

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

	const closeLightbox = useCallback(() => setLightbox(null), []);
	const leech = state?.leech ?? null;

	return (
		<div data-testid="app-root" class="flex h-[100dvh] flex-col overflow-hidden bg-base-100 text-base-content">
			<TopBar
				status={status}
				sessions={counts.sessions}
				subagents={counts.subagents}
				events={counts.events}
				leech={leech}
				scanning={scanning}
				onRescan={handleRescan}
			/>
			<div class="flex min-h-0 flex-1">
				<aside class="w-80 shrink-0 overflow-y-auto border-r border-base-300 bg-base-200">
					<SessionTree sessions={sessions} selectedSessionId={selected?.id ?? null} onSelect={selectSession} />
				</aside>
				<main class="flex min-h-0 min-w-0 flex-1 flex-col">
					{error && (
						<div class="alert alert-warning mx-3 mt-2 py-1.5 text-xs" role="status">
							<span class="truncate">{error}</span>
						</div>
					)}
					{selected ? (
						<>
							<SessionHeader session={selected} parent={parent} onSelect={selectSession} />
							<nav
								aria-label="Breadcrumb"
								class="flex items-center gap-1.5 border-b border-base-300 px-4 py-1 text-[11px] opacity-70"
							>
								<span>Sessions</span>
								{parent && (
									<>
										<span>/</span>
										<button type="button" class="link link-hover" onClick={() => selectSession(parent.id)}>
											{parent.agentName ?? "parent"}
										</button>
									</>
								)}
								<span>/</span>
								<span class="font-medium opacity-100">{selected.agentName ?? "session"}</span>
							</nav>
							<div class="min-h-0 flex-1">
								<ActivityFeed
									events={events}
									sessions={sessions}
									selected={selected}
									onSelectSession={selectSession}
									onOpenImage={setLightbox}
								/>
							</div>
						</>
					) : (
						<div class="flex flex-1 items-center justify-center p-8">
							<div class="alert alert-info max-w-md">
								<span>
									No session selected. Start a pi session with the pi-wabapp extension, or enable the leech
									watcher to tail existing transcripts.
								</span>
							</div>
						</div>
					)}
					<PromptBar target={selected} onSend={handleSend} />
				</main>
			</div>
			<LightboxModal asset={lightbox} onClose={closeLightbox} />
		</div>
	);
}
