import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MediaAsset, SessionNode, WebappEvent, WebappEventType } from "../../src/protocol.js";
import { bool, mediaList, str } from "../../src/protocol.js";
import { detectOutput, highlightTokens, type HighlightToken } from "../highlight.js";
import { sessionName } from "../format";
import { MarkdownText } from "./MarkdownText";
import { MediaCard } from "./MediaCard";

export interface ActivityFeedProps {
	/** Global expand toggle: opens every collapsed message, tool output and thinking block. */
	expandAll?: boolean;
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
/** Placeholder tool output that carries no information. */
const EMPTY_OUTPUT = /^\(?(no output|no result|empty|undefined|null|\{\}|\[\])\)?$/i;

interface ToolItem {
	kind: "tool";
	key: string;
	start?: WebappEvent;
	end?: WebappEvent;
}

type TimelineItem = ToolItem | { kind: "event"; key: string; event: WebappEvent };

/** A tool call or a fragment of the agent's reasoning, both read as "work". */
type WorkEntry = ToolItem | { kind: "thought"; key: string; event: WebappEvent };

type TimelineRow =
	| { kind: "work"; key: string; items: WorkEntry[] }
	| { kind: "event"; key: string; event: WebappEvent };

function callId(event: WebappEvent): string {
	return pickString(event, ["toolCallId", "callId", "id"]);
}

function toolName(event: WebappEvent | undefined): string {
	if (!event) return "";
	return pickString(event, ["name", "toolName", "tool"]);
}

/** Assistant turns that only carry reasoning belong with the tools they explain. */
function isThoughtOnly(event: WebappEvent): boolean {
	if (event.type !== "assistant_message") return false;
	const text = pickString(event, ["text", "message", "content"]);
	const reasoning = pickString(event, ["reasoning", "thinking"]);
	return text.trim().length === 0 && reasoning.trim().length > 0;
}

const SYSTEM_LABELS: Partial<Record<WebappEventType, string>> = {
	session_started: "session started",
	session_ended: "session ended",
	session_meta: "session metadata",
	agent_start: "agent started",
	agent_end: "agent ended",
};


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
			class="btn btn-ghost btn-xs h-auto min-h-0 px-1 py-0 font-normal text-primary opacity-85 hover:opacity-100"
			onClick={() => onSelectSession(id)}
		>
			Open {name} session →
		</button>
	);
}

interface RenderProps {
	selectedId?: string;
	expandAll?: boolean;
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
function ClampedMarkdown({ text, expandAll = false }: { text: string; expandAll?: boolean }) {
	const [open, setOpen] = useState(false);
	const long = text.length > 1_200 || text.split("\n").length > 24;
	if (!long || expandAll) return <MarkdownText text={text} />;
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
function speakerFor(event: WebappEvent, sessions: SessionNode[], selectedId?: string): string {
	// Inside a session's own view the header already says who is speaking.
	if (selectedId && event.sessionId === selectedId) return "";
	const session = sessions.find((candidate) => candidate.id === event.sessionId);
	if (session) return sessionName(session);
	return event.agentName ?? "agent";
}

function oneLine(text: string, limit = 200): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function renderAssistant({ event, sessions, selectedId, expandAll }: RenderProps) {
	const text = pickText(event, ["text", "message", "content"]);
	const reasoning = pickString(event, ["reasoning", "thinking"]);
	const speaker = speakerFor(event, sessions, selectedId);
	// Tool-only turns produce empty assistant messages; they would leave blank
	// gaps in the feed for no information.
	if (text.trim().length === 0 && reasoning.trim().length === 0) return null;
	return (
		<div class="group my-1 flex flex-col items-start gap-1">
			{speaker && <div class="text-micro font-medium uppercase tracking-wide opacity-75">{speaker}</div>}
			{text.trim().length > 0 && (
				<div class="w-full text-body leading-[1.7]">
					{bool(event.data.streaming) ? (
						<>
							<MarkdownText text={text} />
							<span class="ml-1 font-mono text-caption text-primary/70" data-testid="streaming">
								▍writing
							</span>
						</>
					) : (
						<ClampedMarkdown text={text} expandAll={expandAll} />
					)}
				</div>
			)}
			{reasoning && (
				<details class="w-full rounded-md border border-secondary/25 bg-secondary/5" open={expandAll} data-testid="thinking">
					<summary class="flex cursor-pointer list-none items-baseline gap-2 px-2 py-1">
						<span class="shrink-0 font-mono text-caption uppercase tracking-wide text-secondary/80">reasoning</span>
						<span class="line-clamp-1 min-w-0 flex-1 italic text-meta text-base-content/60">
							{oneLine(reasoning, 140)}
						</span>
					</summary>
					<div class="thinking whitespace-pre-wrap border-t border-secondary/20 px-2 py-1.5 text-meta italic leading-relaxed text-base-content/65">
						{reasoning}
					</div>
				</details>
			)}
		</div>
	);
}

function OutputTokens({ tokens }: { tokens: HighlightToken[] }) {
	return (
		<>
			{tokens.map((token, index) =>
				typeof token === "string" ? (
					token
				) : (
					<span key={index} class={`hljs-${token.kind.split(" ")[0] ?? "text"}`}>
						<OutputTokens tokens={token.children} />
					</span>
				),
			)}
		</>
	);
}

/** One tool call: the request, its outcome and optionally its output. */
function ToolLine({ item, expandAll }: { item: ToolItem; expandAll: boolean }) {
	const start = item.start;
	const end = item.end;
	const event = end ?? start;
	if (!event) return null;
	const name = pickString(event, ["name", "toolName", "tool"]) || "tool";
	const requestSource = start ?? end;
	const request = requestSource ? oneLine(pickText(requestSource, ["summary", "input", "args", "command"]), 400) : "";
	const output = end ? pickText(end, ["output", "result", "detail", "error", "summary"]) : "";
	const ok = end ? succeeded(end) : undefined;
	const flatOutput = output.replace(/\s+/g, " ").trim();
	const usefulOutput =
		output.length > 0 && !EMPTY_OUTPUT.test(flatOutput) && !request.startsWith(flatOutput.slice(0, 60));
	const [open, setOpen] = useState(false);
	const expanded = expandAll || open;
	const shape = detectOutput(output, request);
	const tokens = shape.language ? highlightTokens(shape.text, shape.language) : null;
	const lines = shape.text.trim().length > 0 ? shape.text.trim().split("\n").length : 0;
	return (
		<div class="group flex min-w-0 flex-col" data-testid="tool-card" data-event-type="tool">
			<div
				class={`flex min-w-0 items-baseline gap-1.5 rounded-md px-1 py-1 hover:bg-base-200/60 ${
					ok === false ? "bg-error/5" : ""
				}`}
			>
				<span
					class={`w-3 shrink-0 text-center font-mono text-meta ${
						ok === undefined ? "text-info" : ok ? "text-success/80" : "text-error"
					}`}
					aria-label={ok === undefined ? "running" : ok ? "succeeded" : "failed"}
				>
					{ok === undefined ? "•" : ok ? "✓" : "✗"}
				</span>
				<span
					class={`shrink-0 rounded bg-base-300/70 px-1 py-0.5 font-mono text-caption font-medium tracking-wide ${
						ok === false ? "text-error" : "text-base-content/85"
					}`}
				>
					{name}
				</span>
				<span class="min-w-0 flex-1 truncate font-mono text-meta leading-snug text-base-content/60" title={request || undefined}>
					{request}
				</span>
				{usefulOutput && (
					<button
						type="button"
						class={`shrink-0 rounded px-1 font-mono text-caption tabular-nums hover:text-base-content ${
							expanded ? "text-base-content/70" : "text-base-content/35"
						}`}
						onClick={() => setOpen((value) => !value)}
						aria-expanded={expanded}
						title={expanded ? "Hide the tool output" : "Show the tool output"}
						data-testid="output-toggle"
					>
						{lines > 0 ? `${lines} lines` : "output"} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
					</button>
				)}
			</div>
			{usefulOutput && expanded && (
				<div class="relative ml-[1.125rem] border-l border-dashed border-base-300 pl-3" data-testid="output-connector">
					<span class="absolute -top-1 left-0 size-1.5 -translate-x-1/2 rounded-full bg-base-300" aria-hidden="true" />
					<div class="my-1 overflow-hidden rounded-md border border-l-0 border-base-300/70 bg-base-300/20">
						<div class="flex items-center gap-2 border-b border-base-300/50 px-2 py-0.5 font-mono text-caption opacity-50">
							<span>output</span>
							<span class="rounded bg-base-300/60 px-1" data-testid="output-language">
								{shape.label}
							</span>
							<span class="ml-auto tabular-nums">{lines} lines</span>
						</div>
						<pre
							class="hljs-pre max-h-80 overflow-y-auto whitespace-pre-wrap break-words p-2 font-mono text-meta leading-relaxed text-base-content/75"
							data-testid="tool-output"
						>
							{tokens ? <OutputTokens tokens={tokens} /> : shape.text}
						</pre>
					</div>
				</div>
			)}
		</div>
	);
}

/** Consecutive tool calls and their reasoning read as one unit of work. */
function WorkBlock({ items, expandAll }: { items: WorkEntry[]; expandAll: boolean }) {
	const [open, setOpen] = useState(true);
	const tools = items.filter((item): item is ToolItem => item.kind === "tool");
	const running = tools.some((item) => !item.end);
	const failures = tools.filter((item) => item.end && !succeeded(item.end)).length;
	return (
		<div class="group/block my-0.5" data-testid="work-block">
			{tools.length > 1 && (
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-micro uppercase tracking-wide opacity-85 hover:opacity-90"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				<span class="font-mono">{open ? "▾" : "▸"}</span>
				<span>
					{tools.length} {tools.length === 1 ? "step" : "steps"}
				</span>
				{failures > 0 && <span class="text-error normal-case">{failures} failed</span>}
				{running && <span class="text-info normal-case">running…</span>}
			</button>
			)}
			{open && (
				<div class="mt-0.5 flex flex-col gap-0.5 border-l border-base-300/70 pl-2">
					{items.map((item) =>
						item.kind === "tool" ? (
							<ToolLine key={item.key} item={item} expandAll={expandAll} />
						) : (
							<ThoughtLine key={item.key} event={item.event} expandAll={expandAll} />
						),
					)}
				</div>
			)}
		</div>
	);
}

/** A reasoning step sits between the tool calls it explains, dim and one line. */
function ThoughtLine({ event, expandAll }: { event: WebappEvent; expandAll: boolean }) {
	const reasoning = pickString(event, ["reasoning", "thinking"]);
	if (!reasoning.trim()) return null;
	return (
		<details class="group my-0.5 rounded-md border border-secondary/20 bg-secondary/5" open={expandAll} data-testid="thinking">
			<summary class="flex cursor-pointer list-none items-baseline gap-2 px-2 py-1">
				<span class="shrink-0 font-mono text-caption uppercase tracking-wide text-secondary/80">reasoning</span>
				<span class="min-w-0 flex-1 truncate italic text-meta text-base-content/55" title={oneLine(reasoning, 400)}>
					{oneLine(reasoning, 200)}
				</span>
			</summary>
			<div class="whitespace-pre-wrap border-t border-secondary/20 px-2 py-1.5 text-meta italic leading-relaxed text-base-content/65">
				{reasoning}
			</div>
		</details>
	);
}

function renderSubagentSpawned({ event, sessions, onSelectSession }: RenderProps) {
	const agent = pickString(event, ["agentName", "agent", "subagentName"]) || event.agentName || "subagent";
	const task = pickText(event, ["task", "prompt", "description"]);
	const childId = resolveChildId(event, sessions);
	return (
		<div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 border-secondary/50 pl-2.5 py-1">
			<span class="shrink-0 text-meta font-medium">{agent}</span>
			<span class="shrink-0 text-meta opacity-70">started</span>
			{task && <span class="min-w-0 flex-1 truncate text-meta opacity-70" title={task}>{oneLine(task, 120)}</span>}
			{childId && (
				<span class="ml-auto shrink-0">
					<OpenSessionButton id={childId} name={agent} onSelectSession={onSelectSession} />
				</span>
			)}
		</div>
	);
}

function renderSubagentCompleted({ event, sessions, onSelectSession }: RenderProps) {
	const agent = pickString(event, ["agentName", "agent", "subagentName"]) || event.agentName || "subagent";
	const summary = pickText(event, ["summary", "result", "error"]);
	const ok = succeeded(event);
	const childId = resolveChildId(event, sessions);
	return (
		<div
			class={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 pl-2.5 py-1 ${
				ok ? "border-success/50" : "border-error/60"
			}`}
		>
			<span class="shrink-0 text-meta font-medium">{agent}</span>
			<span class={`shrink-0 text-meta ${ok ? "opacity-70" : "text-error"}`}>{ok ? "finished" : "failed"}</span>
			{summary && <span class="min-w-0 flex-1 truncate text-meta opacity-70" title={summary}>{oneLine(summary, 120)}</span>}
			{childId && (
				<span class="ml-auto shrink-0">
					<OpenSessionButton id={childId} name={agent} onSelectSession={onSelectSession} />
				</span>
			)}
		</div>
	);
}

function renderWorkState({ event, showSubagent, sessions, onSelectSession, onOpenImage, expandAll }: RenderProps) {
	const title = pickString(event, ["title", "label", "name"]) || "work state";
	const body = pickText(event, ["description", "text", "body", "detail", "message", "notes"]);
	const rawUrl = pickString(event, ["url", "link", "href"]);
	const url = /^https?:\/\//.test(rawUrl) ? rawUrl : "";
	const data = eventData(event);
	const media = mediaList(data.media);
	const assets = media.length > 0 ? media : mediaList(data.artifacts);
	return (
		<div class="rounded-box border border-base-300 bg-base-100/40 p-3">
			<div class="flex flex-wrap items-center gap-2">
				<span class="badge badge-info badge-xs">work state</span>
				{showSubagent && (
					<SubagentTag event={event} sessions={sessions} onSelectSession={onSelectSession} />
				)}
				<span class="text-body font-semibold">{title}</span>

			</div>
			{body && (
				<div class="mt-1 text-body">
					<ClampedMarkdown text={body} expandAll={expandAll} />
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
				<div class={`mt-2 grid grid-cols-1 gap-2 ${assets.length > 1 ? "sm:grid-cols-2" : ""}`}>
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
		<div class="flex items-center gap-2 py-1 text-micro uppercase tracking-wide opacity-75">
			<span class="h-px flex-1 bg-base-300" />
			<span class="shrink-0">
				{label}
				{detail ? ` · ${detail}` : ""}
			</span>
			<span class="h-px flex-1 bg-base-300" />
		</div>
	);
}

function EventRow({
	event,
	showSubagent,
	sessions,
	selectedId,
	expandAll,
	onSelectSession,
	onOpenImage,
}: RenderProps) {
	const renderProps: RenderProps = {
		event,
		showSubagent,
		sessions,
		selectedId,
		expandAll,
		onSelectSession,
		onOpenImage,
	};
	let content;
	switch (event.type) {
		case "user_prompt":
			content = (
				<div class="group my-1 flex flex-col items-end gap-1">
					<div class="whitespace-pre-wrap rounded-lg rounded-tr-sm border border-primary/40 bg-primary/15 px-3 py-2 text-body leading-[1.7]">
						{pickText(event, ["text", "prompt", "message"])}
					</div>
				</div>
			);
			break;
		case "assistant_message":
		case "assistant_delta":
			content = renderAssistant(renderProps);
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
				<div class="alert alert-error py-2 text-body" role="alert">
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
					<div class="rounded-box border border-base-300 bg-base-200/40 p-2 font-mono text-meta">
						<div class="flex items-center gap-2">
							<span class="badge badge-ghost badge-xs">{event.type}</span>
						</div>
						<pre class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap opacity-80">
							{fieldText(event.data)}
						</pre>
					</div>
				);
			}
	}
	return (
		<div data-testid="feed-event" data-event-type={event.type}>
			{showSubagent && event.type !== "work_state" && (
				<div class="mb-1">
					<SubagentTag event={event} sessions={sessions} onSelectSession={onSelectSession} />
				</div>
			)}
			{content}
		</div>
	);
}

export function ActivityFeed({
	events,
	sessions,
	selected,
	expandAll = false,
	onSelectSession,
	onOpenImage,
}: ActivityFeedProps) {
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
		return rows
			.filter(
				(event) =>
					event.type !== "session_started" &&
					event.type !== "agent_start" &&
					event.type !== "agent_end" &&
					event.type !== "session_meta",
			)
			.slice()
			.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
	}, [events, selected]);

	// Pair each tool call with its result so one call renders as one row.
	const timeline = useMemo<TimelineItem[]>(() => {
		const calls = visible.filter((event) => event.type === "tool_start" || event.type === "tool_end");
		const starts = new Map<string, number[]>();
		const pairedStart = new Set<number>();
		const pairedEnd = new Set<number>();
		const pairOf = new Map<number, number>();
		calls.forEach((event, index) => {
			if (event.type !== "tool_start") return;
			const id = callId(event);
			if (!id) return;
			const bucket = starts.get(id) ?? [];
			bucket.push(index);
			starts.set(id, bucket);
		});
		// First pass: match on the provider's call id, which live events always carry.
		calls.forEach((event, index) => {
			if (event.type !== "tool_end") return;
			const id = callId(event);
			if (!id) return;
			const startIndex = starts.get(id)?.find((candidate) => !pairedStart.has(candidate));
			if (startIndex === undefined) return;
			pairedStart.add(startIndex);
			pairedEnd.add(index);
			pairOf.set(startIndex, index);
		});
		// Second pass: leeched or synthetic events can omit the call id, so fall
		// back to the nearest unmatched call of the same tool.
		calls.forEach((event, index) => {
			if (event.type !== "tool_end" || pairedEnd.has(index)) return;
			const name = toolName(event);
			for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
				const candidate = calls[cursor];
				if (!candidate || candidate.type !== "tool_start" || pairedStart.has(cursor)) continue;
				const candidateName = toolName(candidate);
				if (name && candidateName && candidateName !== name) continue;
				pairedStart.add(cursor);
				pairedEnd.add(index);
				pairOf.set(cursor, index);
				break;
			}
		});

		const items: TimelineItem[] = [];
		const emitted = new Set<number>();
		visible.forEach((event) => {
			if (event.type !== "tool_start" && event.type !== "tool_end") {
				items.push({ kind: "event", key: event.id, event });
				return;
			}
			const callIndex = calls.indexOf(event);
			if (event.type === "tool_start") {
				if (emitted.has(callIndex)) return;
				emitted.add(callIndex);
				const endIndex = pairOf.get(callIndex);
				if (endIndex !== undefined) emitted.add(endIndex);
				items.push({
					kind: "tool",
					key: `tool:${callId(event) || event.id}`,
					start: event,
					end: endIndex !== undefined ? calls[endIndex] : undefined,
				});
				return;
			}
			if (pairedEnd.has(callIndex) || emitted.has(callIndex)) return;
			emitted.add(callIndex);
			items.push({ kind: "tool", key: `tool:${callId(event) || event.id}`, end: event });
		});
		return items;
	}, [visible]);

	// Everything between two messages or lifecycle events is one work block.
	const rows = useMemo<TimelineRow[]>(() => {
		const out: TimelineRow[] = [];
		let block: WorkEntry[] = [];
		const flush = () => {
			if (block.length === 0) return;
			out.push({ kind: "work", key: block[0]?.key ?? "work", items: block });
			block = [];
		};
		for (const item of timeline) {
			if (item.kind === "tool") {
				block.push(item);
				continue;
			}
			if (isThoughtOnly(item.event)) {
				block.push({ kind: "thought", key: item.key, event: item.event });
				continue;
			}
			flush();
			out.push({ kind: "event", key: item.key, event: item.event });
		}
		flush();
		return out;
	}, [timeline]);

	const lastVisibleId = visible.length > 0 ? visible[visible.length - 1]?.id : "";
	const taskText = selected?.task?.trim() ?? "";
	const firstPrompt = visible.find((event) => event.type === "user_prompt");
	const firstPromptText = firstPrompt ? pickText(firstPrompt, ["text", "prompt", "message"]).trim() : "";
	// The spawn prompt already states the task, so the card only adds noise when
	// it repeats it word for word.
	const redundantTask =
		taskText.length > 0 &&
		firstPromptText.length > 0 &&
		(firstPromptText.includes(taskText) || taskText.includes(firstPromptText));

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
				{selected?.isSubagent && !redundantTask && (
					<div class="sticky top-0 z-10 mb-3 rounded-box border border-base-300 border-l-4 border-l-secondary bg-base-200/95 p-3 backdrop-blur">
						<div class="mb-1 text-micro uppercase tracking-wide opacity-85">task</div>
						<div class="text-body">
							<MarkdownText text={selected.task ?? "No task recorded"} />
						</div>
					</div>
				)}
				{visible.length === 0 ? (
					<div class="flex h-full items-center justify-center p-8">
						<div class="text-center text-body opacity-80">
							<p class="font-semibold">No activity yet</p>
							<p class="mt-1 text-meta">
								{selected?.isSubagent
									? "This subagent has not reported activity yet."
									: "Events will appear here as the agent works."}
							</p>
						</div>
					</div>
				) : (
					<div class="flex flex-col gap-2 pt-1 pb-4">
						{rows.map((row) =>
							row.kind === "work" ? (
								<WorkBlock key={row.key} items={row.items} expandAll={expandAll} />
							) : (
								<EventRow
									key={row.key}
									event={row.event}
									showSubagent={
										!!selected &&
										row.event.parentSessionId === selected.id &&
										row.event.sessionId !== selected.id
									}
									sessions={sessions}
									selectedId={selected?.id}
									expandAll={expandAll}
									onSelectSession={onSelectSession}
									onOpenImage={onOpenImage}
								/>
							),
						)}
					</div>
				)}
			</div>
			{!atBottom && visible.length > 0 && (
				<button
					type="button"
					class="btn btn-primary btn-xs absolute right-4 bottom-4 shadow-lg"
					onClick={jumpToLatest}
				>
					▼ jump to latest
				</button>
			)}
		</div>
	);
}
