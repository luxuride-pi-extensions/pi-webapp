import { useMemo } from "preact/hooks";
import type { SessionNode, WebappEvent } from "../../src/protocol.js";
import { sessionName } from "../format.js";
import { StatusBadge } from "./StatusBadge";

export interface SubagentRailProps {
	/** Session whose subagents are listed. */
	session: SessionNode;
	sessions: SessionNode[];
	events: WebappEvent[];
	onSelect: (id: string) => void;
}

const PREVIEW_LIMIT = 140;

/** Events that carry a subagent's actual output rather than tool mechanics. */
const OUTPUT_TYPES = new Set(["assistant_message", "work_state", "subagent_completed", "error"]);

function pickText(event: WebappEvent, keys: readonly string[]): string {
	const data = event.data && typeof event.data === "object" ? event.data : {};
	for (const key of keys) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function eventPreview(event: WebappEvent): string {
	switch (event.type) {
		case "assistant_message":
			return pickText(event, ["text"]);
		case "user_prompt":
			return pickText(event, ["text", "prompt"]);
		case "work_state":
			return pickText(event, ["title", "description"]);
		case "tool_start":
			return pickText(event, ["summary", "toolName"]);
		case "tool_end":
			return pickText(event, ["summary", "toolName"]);
		case "subagent_spawned":
			return pickText(event, ["task", "description", "agentName"]);
		case "subagent_completed":
			return pickText(event, ["summary", "result"]);
		case "error":
			return pickText(event, ["message", "error"]);
		default:
			return "";
	}
}

function clock(timestamp: number): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function truncate(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > PREVIEW_LIMIT ? `${collapsed.slice(0, PREVIEW_LIMIT - 1)}…` : collapsed;
}

interface RailItem {
	session: SessionNode;
	last: WebappEvent | null;
	count: number;
}

/**
 * Live per-subagent output list for the selected parent session. Keeps the
 * parent feed readable: subagents report their progress here, side by side,
 * instead of interleaving with the main agent's transcript.
 */
export function SubagentRail({ session, sessions, events, onSelect }: SubagentRailProps) {
	const items = useMemo<RailItem[]>(() => {
		const children = sessions.filter(
			(child) => child.parentSessionId === session.id && child.id !== session.id,
		);
		const bySession = new Map<string, WebappEvent[]>();
		for (const event of events) {
			if (event.sessionId === session.id) continue;
			const bucket = bySession.get(event.sessionId);
			if (bucket) bucket.push(event);
			else bySession.set(event.sessionId, [event]);
		}
		return children
			.map((child) => {
				const childEvents = (bySession.get(child.id) ?? [])
					.slice()
					.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
				// Prefer the subagent's own words over tool invocations: the rail is
				// meant to show what it is producing, not which tool it touched.
				const findLast = (predicate: (event: WebappEvent) => boolean): WebappEvent | null => {
					for (let index = childEvents.length - 1; index >= 0; index -= 1) {
						const candidate = childEvents[index];
						if (candidate && predicate(candidate)) return candidate;
					}
					return null;
				};
				const last =
					findLast((event) => OUTPUT_TYPES.has(event.type) && !!eventPreview(event)) ??
					findLast((event) => !!eventPreview(event)) ??
					childEvents[childEvents.length - 1] ??
					null;
				return { session: child, last, count: childEvents.length };
			})
			.sort((a, b) => (b.last?.timestamp ?? b.session.updatedAt) - (a.last?.timestamp ?? a.session.updatedAt));
	}, [session.id, sessions, events]);

	if (items.length === 0) return null;

	return (
		<aside
			class="hidden w-80 shrink-0 flex-col border-l border-base-300 bg-base-200/40 lg:flex"
			aria-label="Subagents"
			data-testid="subagent-rail"
		>
			<header class="flex items-center gap-2 border-b border-base-300 px-3 py-2">
				<h2 class="text-meta font-semibold tracking-wide uppercase opacity-85">Subagents</h2>
				<span class="badge badge-ghost badge-xs">{items.length}</span>
				<span class="ml-auto font-mono text-micro opacity-82">live</span>
			</header>
			<ul class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
				{items.map(({ session: child, last, count }) => {
					const name = sessionName(child);
					const preview = last ? eventPreview(last) : "";
					const working = child.busy === true;
					const live = child.status === "running";
					return (
						<li key={child.id}>
							<button
								type="button"
								class="w-full rounded-lg border border-base-300 bg-base-100/60 p-2 text-left hover:border-primary/40 hover:bg-base-100"
								onClick={() => onSelect(child.id)}
								title={child.title ?? child.id}
								data-testid="subagent-rail-item"
							>
								<div class="flex items-center gap-1.5">
									{working ? (
										<span class="size-1.5 rounded-full bg-info" title="Working on a message" aria-hidden="true" />
									) : live ? (
										<span class="size-1.5 rounded-full bg-success/60" title="Running, idle" aria-hidden="true" />
									) : null}
									<span class="min-w-0 flex-1 truncate text-meta font-medium">{name}</span>
									<StatusBadge status={child.status} size="xs" />
									<span class="shrink-0 whitespace-nowrap font-mono text-caption tabular-nums opacity-70">
										{last ? clock(last.timestamp) : ""}
									</span>
								</div>
								{child.title && child.title !== name && (
									<p class="mt-0.5 line-clamp-1 text-caption opacity-70">{child.title}</p>
								)}
								{preview && (
									<p class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-meta leading-snug opacity-80">
										{truncate(preview)}
									</p>
								)}
								<div class="mt-1 flex items-center gap-2 font-mono text-caption opacity-70">
									<span class="shrink-0">{count} events</span>
									<span class="ml-auto shrink-0 whitespace-nowrap">open →</span>
								</div>
							</button>
						</li>
					);
				})}
			</ul>
		</aside>
	);
}
