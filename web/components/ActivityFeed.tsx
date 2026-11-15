import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MediaAsset, SessionNode, WebappEvent, WebappEventType } from "../../src/protocol.js";
import { bool, mediaList, num, str } from "../../src/protocol.js";
import { sessionName } from "../format";
import { MarkdownText } from "./MarkdownText";
import { MediaCard } from "./MediaCard";

export interface ActivityFeedProps {
	events: WebappEvent[];
	sessions: SessionNode[];
	selected: SessionNode | null;
	onSelectSession: (id: string) => void;
	onOpenImage: (asset: MediaAsset) => void;
}

const NEAR_BOTTOM_PX = 120;

/** Events a subagent may contribute to its parent's feed. */
const CHILD_FEED_TYPES = new Set<WebappEventType>([
	"subagent_spawned",
	"subagent_completed",
	"work_state",
	"session_started",
	"session_ended",
	"error",
]);
const SUMMARY_DETAIL_LIMIT = 160;

const SYSTEM_LABELS: Partial<Record<WebappEventType, string>> = {
	session_started: "session started",
	session_ended: "session ended",
	session_meta: "session metadata",
	agent_start: "agent started",
	agent_end: "agent ended",
};

function clock(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fieldText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	try {
		const json = JSON.stringify(value);
		return json.length > 800 ? `${json.slice(0, 800)}…` : json;
	} catch {
		return "";
	}
}

function eventData(event: WebappEvent): Record<string, unknown> {
	return event.data && typeof event.data === "object" ? event.data : {};
}

function pickString(event: WebappEvent, keys: readonly string[]): string {
	const data = eventData(event);
	for (const key of keys) {
		const value = str(data[key]);
		if (value) return value;
	}
	return "";
}

function pickText(event: WebappEvent, keys: readonly string[]): string {
	const data = eventData(event);
	for (const key of keys) {
		const value = fieldText(data[key]);
		if (value) return value;
	}
	return "";
}

function succeeded(event: WebappEvent): boolean {
	const data = eventData(event);
	if (typeof data.success === "boolean") return data.success;
	if (typeof data.ok === "boolean") return data.ok;
	if (bool(data.isError)) return false;
	return !pickString(event, ["error"]);
}

function durationMs(event: WebappEvent): number {
	const data = eventData(event);
	return num(data.durationMs) || num(data.duration) || num(data.elapsedMs);
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "";
	return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function resolveChildId(event: WebappEvent, sessions: SessionNode[]): string | null {
	const direct = pickString(event, ["childSessionId", "agentSessionId", "subagentSessionId"]);
	if (direct && sessions.some((session) => session.id === direct)) return direct;
	const fromData = pickString(event, ["sessionId"]);
	if (fromData && fromData !== event.sessionId && sessions.some((session) => session.id === fromData)) {
		return fromData;
	}
	const agent = pickString(event, ["agentName", "agent", "subagentName"]) || event.agentName || "";
	const child = sessions.find(
		(session) =>
			session.isSubagent &&
			session.id !== event.sessionId &&
			(session.parentSessionId === event.sessionId || session.parentSessionId === event.parentSessionId) &&
			(!agent || session.agentName === agent),
	);
	return child?.id ?? null;
}

function SubagentTag({
	event,
	sessions,
	onSelectSession,
}: {
	event: WebappEvent;
	sessions: SessionNode[];
	onSelectSession: (id: string) => void;
}) {
	const name =
		event.agentName || sessions.find((session) => session.id === event.sessionId)?.agentName || "agent";
	return (
		<button
			type="button"
			class="badge badge-secondary badge-outline badge-sm hover:badge-secondary"
			onClick={() => onSelectSession(event.sessionId)}
			title={`Open ${name}'s session`}
		>
			[subagent: {name}]
		</button>
	);
}

function OpenSessionButton({ id, name, onSelectSession }: { id: string; name: string; onSelectSession: (id: string) => void }) {
	return (
		<button
			type="button"
			class="btn btn-ghost btn-xs mt-1 self-start px-0 text-primary"
			onClick={() => onSelectSession(id)}
		>
			Open {name} session →
		</button>
	);
}

interface RenderProps {
	event: WebappEvent;
	showSubagent: boolean;
	sessions: SessionNode[];
	onSelectSession: (id: string) => void;
	onOpenImage: (asset: MediaAsset) => void;
}

/**
 * Long agent output stays readable: clamp the bubble, keep the full text one
 * click away.
 */
function ClampedMarkdown({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > 700 || text.split("\n").length > 10;
	if (!long) return <MarkdownText text={text} />;
	return (
		<div>
			<div class={open ? undefined : "max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"}>
				<MarkdownText text={text} />
			</div>
			<button
				type="button"
				class="btn btn-ghost btn-xs mt-1 px-1 text-primary"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				{open ? "show less" : `show more (${text.length.toLocaleString()} chars)`}
			</button>
		</div>
	);
}

/** Whose words these are: the session's dashboard name, not a generic label. */
function speakerFor(event: WebappEvent, sessions: SessionNode[]): string {
	const session = sessions.find((candidate) => candidate.id === event.sessionId);
	if (session) return sessionName(session);
	return event.agentName ?? "agent";
}

function renderAssistant({ event, sessions }: RenderProps) {
	const text = pickText(event, ["text", "message", "content"]);
	const reasoning = pickString(event, ["reasoning", "thinking"]);
	return (
		<div class="chat chat-start">
			<div class="chat-header mb-1 text-xs opacity-60">
				{speakerFor(event, sessions)}
				<time class="ml-2 font-mono opacity-70">{clock(event.timestamp)}</time>
			</div>
			<div class="chat-bubble max-w-[85%] bg-base-200 text-sm text-base-content">
				<ClampedMarkdown text={text} />
				{reasoning && (
					<details class="mt-2 text-xs">
						<summary class="cursor-pointer opacity-60">reasoning</summary>
						<div class="thinking mt-1 whitespace-pre-wrap">{reasoning}</div>
					</details>
				)}
			</div>
		</div>
	);
}

function ToolHeader({
	event,
	sessions,
	ok,
	duration,
}: {
	event: WebappEvent;
	sessions: SessionNode[];
	ok?: boolean;
	duration?: string;
}) {
	const name = pickString(event, ["name", "toolName", "tool"]) || "tool";
	return (
		<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
			{ok !== undefined && (
				<span class={`font-mono font-bold ${ok ? "text-success" : "text-error"}`}>{ok ? "✓" : "✗"}</span>
			)}
			<span class="badge badge-ghost badge-xs font-mono">tool</span>
			<span class="text-sm font-semibold">{name}</span>
			{duration && <span class="badge badge-ghost badge-xs font-mono">{duration}</span>}
			<span class="text-[10px] opacity-50">{speakerFor(event, sessions)}</span>
			<time class="ml-auto shrink-0 font-mono text-[10px] opacity-40">{clock(event.timestamp)}</time>
		</div>
	);
}

function renderToolStart({ event, sessions }: RenderProps) {
	const summary = pickText(event, ["summary", "input", "args"]);
	return (
		<div class="rounded-md border border-base-300 bg-base-200/50 px-2 py-1 text-xs" data-testid="tool-card">
			<ToolHeader event={event} sessions={sessions} />
			{summary && (
				<pre class="mt-1 max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words opacity-70">
					{summary}
				</pre>
			)}
		</div>
	);
}

function renderToolEnd({ event, sessions }: RenderProps) {
	const summary = pickText(event, ["summary", "result", "output", "detail", "error"]);
	const ok = succeeded(event);
	const duration = formatDuration(durationMs(event));
	return (
		<div class="rounded-md border border-base-300 bg-base-200/50 px-2 py-1 text-xs" data-testid="tool-card">
			<ToolHeader event={event} sessions={sessions} ok={ok} duration={duration} />
			{summary && (
				<details class="mt-1" open={summary.length <= SUMMARY_DETAIL_LIMIT}>
					<summary class="cursor-pointer text-[10px] uppercase tracking-wide opacity-50">output</summary>
					<pre class="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] opacity-80">
						{summary}
					</pre>
				</details>
			)}
		</div>
	);
}

function renderSubagentSpawned({ event, sessions, onSelectSession }: RenderProps) {
	const agent = pickString(event, ["agentName", "agent", "subagentName"]) || event.agentName || "subagent";
	const task = pickText(event, ["task", "prompt", "description"]);
	const childId = resolveChildId(event, sessions);
	return (
		<div class="rounded-box border border-base-300 border-l-4 border-l-secondary bg-base-200 p-3">
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<span class="badge badge-secondary badge-sm">subagent</span>
				<span>
					spawned <span class="font-semibold">{agent}</span>
				</span>
				<time class="ml-auto font-mono text-[10px] opacity-40">{clock(event.timestamp)}</time>
			</div>
			{task && <p class="mt-1 whitespace-pre-wrap text-xs opacity-70">{task}</p>}
			{childId && <OpenSessionButton id={childId} name={agent} onSelectSession={onSelectSession} />}
		</div>
	);
}

function renderSubagentCompleted({ event, sessions, onSelectSession }: RenderProps) {
	const agent = pickString(event, ["agentName", "agent", "subagentName"]) || event.agentName || "subagent";
	const summary = pickText(event, ["summary", "result", "error"]);
	const ok = succeeded(event);
	const duration = formatDuration(durationMs(event));
	const childId = resolveChildId(event, sessions);
	return (
		<div
			class={`rounded-box border border-base-300 border-l-4 bg-base-200 p-3 ${
				ok ? "border-l-success" : "border-l-error"
			}`}
		>
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<span class={`badge badge-sm ${ok ? "badge-success" : "badge-error"}`}>{ok ? "completed" : "failed"}</span>
				<span class="font-semibold">{agent}</span>
				{duration && <span class="badge badge-ghost badge-xs font-mono">{duration}</span>}
				<time class="ml-auto font-mono text-[10px] opacity-40">{clock(event.timestamp)}</time>
			</div>
			{summary && <p class="mt-1 whitespace-pre-wrap text-xs opacity-70">{summary}</p>}
			{childId && <OpenSessionButton id={childId} name={agent} onSelectSession={onSelectSession} />}
		</div>
	);
}

function renderWorkState({ event, showSubagent, sessions, onSelectSession, onOpenImage }: RenderProps) {
	const title = pickString(event, ["title", "label", "name"]) || "work state";
	const body = pickText(event, ["description", "text", "body", "detail", "message", "notes"]);
	const rawUrl = pickString(event, ["url", "link", "href"]);
	const url = /^https?:\/\//.test(rawUrl) ? rawUrl : "";
	const data = eventData(event);
	const media = mediaList(data.media);
	const assets = media.length > 0 ? media : mediaList(data.artifacts);
	return (
		<div class="rounded-box border border-base-300 bg-base-200 p-3">
			<div class="flex flex-wrap items-center gap-2">
				<span class="badge badge-info badge-xs">work state</span>
				{showSubagent && (
					<SubagentTag event={event} sessions={sessions} onSelectSession={onSelectSession} />
				)}
				<span class="text-sm font-semibold">{title}</span>
				<time class="ml-auto font-mono text-[10px] opacity-40">{clock(event.timestamp)}</time>
			</div>
			{body && (
				<div class="mt-1 text-sm">
					<ClampedMarkdown text={body} />
				</div>
			)}
			{url && (
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					class="badge badge-outline badge-sm mt-2 max-w-full gap-1 font-mono hover:badge-primary"
					title={url}
				>
					↗ <span class="truncate">{url}</span>
				</a>
			)}
			{assets.length > 0 && (
				<div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
					{assets.map((asset, index) => (
						<MediaCard key={`${asset.url}-${index}`} asset={asset} onOpenImage={onOpenImage} />
					))}
				</div>
			)}
		</div>
	);
}

function renderSystem({ event }: RenderProps) {
	const label = SYSTEM_LABELS[event.type] ?? event.type;
	const detail = pickString(event, ["title", "model", "cwd", "agentName"]) || event.agentName || "";
	return (
		<div class="flex items-center gap-2 px-2 py-0.5 text-[10px] uppercase tracking-wide opacity-45">
			<span class="h-px flex-1 bg-base-300" />
			<span>
				{label}
				{detail ? `: ${detail}` : ""}
			</span>
			<time class="font-mono">{clock(event.timestamp)}</time>
			<span class="h-px flex-1 bg-base-300" />
		</div>
	);
}

function EventRow({ event, showSubagent, sessions, onSelectSession, onOpenImage }: RenderProps) {
	const renderProps: RenderProps = { event, showSubagent, sessions, onSelectSession, onOpenImage };
	let content;
	switch (event.type) {
		case "user_prompt":
			content = (
				<div class="chat chat-end">
					<div class="chat-header mb-1 text-xs opacity-60">
						operator
						<time class="ml-2 font-mono opacity-70">{clock(event.timestamp)}</time>
					</div>
					<div class="chat-bubble chat-bubble-primary whitespace-pre-wrap text-sm">
						{pickText(event, ["text", "prompt", "message"])}
					</div>
				</div>
			);
			break;
		case "assistant_message":
			content = renderAssistant(renderProps);
			break;
		case "tool_start":
			content = renderToolStart(renderProps);
			break;
		case "tool_end":
			content = renderToolEnd(renderProps);
			break;
		case "subagent_spawned":
			content = renderSubagentSpawned(renderProps);
			break;
		case "subagent_completed":
			content = renderSubagentCompleted(renderProps);
			break;
		case "work_state":
			content = renderWorkState(renderProps);
			break;
		case "error":
			content = (
				<div class="alert alert-error py-2 text-sm" role="alert">
					<span class="font-semibold">error</span>
					<span class="min-w-0 whitespace-pre-wrap">
						{pickText(event, ["message", "error", "detail"]) || "unknown error"}
					</span>
				</div>
			);
			break;
		default:
			if (SYSTEM_LABELS[event.type]) {
				content = renderSystem(renderProps);
			} else {
				content = (
					<div class="rounded-box border border-base-300 bg-base-200/40 p-2 font-mono text-xs">
						<div class="flex items-center gap-2">
							<span class="badge badge-ghost badge-xs">{event.type}</span>
							<time class="ml-auto text-[10px] opacity-40">{clock(event.timestamp)}</time>
						</div>
						<pre class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap opacity-60">
							{fieldText(event.data)}
						</pre>
					</div>
				);
			}
	}
	return (
		<div class="fade-in" data-testid="feed-event" data-event-type={event.type}>
			{showSubagent && event.type !== "work_state" && (
				<div class="mb-1">
					<SubagentTag event={event} sessions={sessions} onSelectSession={onSelectSession} />
				</div>
			)}
			{content}
		</div>
	);
}

export function ActivityFeed({ events, sessions, selected, onSelectSession, onOpenImage }: ActivityFeedProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const atBottomRef = useRef(true);
	const [atBottom, setAtBottom] = useState(true);

	const visible = useMemo(() => {
		if (!selected) return [];
		// A subagent's turn-by-turn chatter belongs to its own view. The parent
		// feed only carries lifecycle markers plus visual artifacts that were
		// explicitly attributed to it.
		const rows = selected.isSubagent
			? events.filter((event) => event.sessionId === selected.id)
			: events.filter(
					(event) =>
						event.sessionId === selected.id ||
						(event.parentSessionId === selected.id && CHILD_FEED_TYPES.has(event.type)),
				);
		return rows.slice().sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
	}, [events, selected]);

	const lastVisibleId = visible.length > 0 ? visible[visible.length - 1]?.id : "";

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		element.scrollTop = element.scrollHeight;
		atBottomRef.current = true;
		setAtBottom(true);
	}, [selected?.id]);

	useEffect(() => {
		if (!atBottomRef.current) return;
		const element = scrollRef.current;
		if (!element) return;
		const frame = requestAnimationFrame(() => {
			element.scrollTop = element.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [lastVisibleId, visible.length, selected?.id]);

	const updateAtBottom = () => {
		const element = scrollRef.current;
		if (!element) return;
		const near = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
		atBottomRef.current = near;
		setAtBottom(near);
	};

	const jumpToLatest = () => {
		const element = scrollRef.current;
		if (!element) return;
		element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
		atBottomRef.current = true;
		setAtBottom(true);
	};

	return (
		<div class="relative flex h-full min-h-0 flex-col">
			<div
				ref={scrollRef}
				onScroll={updateAtBottom}
				class="feed-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3"
				data-testid="feed"
			>
				{selected?.isSubagent && (
					<div class="sticky top-0 z-10 mb-3 rounded-box border border-base-300 border-l-4 border-l-secondary bg-base-200/95 p-3 backdrop-blur">
						<div class="mb-1 text-[10px] uppercase tracking-wide opacity-50">task</div>
						<div class="text-sm">
							<MarkdownText text={selected.task ?? "No task recorded"} />
						</div>
					</div>
				)}
				{visible.length === 0 ? (
					<div class="flex h-full items-center justify-center p-8">
						<div class="text-center text-sm opacity-60">
							<p class="font-semibold">No activity yet</p>
							<p class="mt-1 text-xs">
								{selected?.isSubagent
									? "This subagent has not reported activity yet."
									: "Events will appear here as the agent works."}
							</p>
						</div>
					</div>
				) : (
					<div class="flex flex-col gap-2">
						{visible.map((event) => (
							<EventRow
								key={event.id}
								event={event}
								showSubagent={
									!!selected && event.parentSessionId === selected.id && event.sessionId !== selected.id
								}
								sessions={sessions}
								onSelectSession={onSelectSession}
								onOpenImage={onOpenImage}
							/>
						))}
					</div>
				)}
			</div>
			{!atBottom && visible.length > 0 && (
				<button
					type="button"
					class="btn btn-primary btn-xs absolute bottom-4 left-1/2 -translate-x-1/2 shadow-lg"
					onClick={jumpToLatest}
				>
					▼ jump to latest
				</button>
			)}
		</div>
	);
}
