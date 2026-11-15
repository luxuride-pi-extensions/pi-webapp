import type { SessionNode, SessionSource, SessionStatus } from "../../src/protocol.js";

export interface StatusBadgeProps {
	status: SessionStatus;
	source?: SessionSource;
	size?: "xs" | "sm";
	className?: string;
}

const STATUS_CLASS: Record<SessionStatus, string> = {
	running: "badge-success",
	completed: "badge-ghost",
	failed: "badge-error",
};

/**
 * Lifecycle of the session itself: is a pi instance attached and healthy.
 * This says nothing about whether a message is currently being processed — see
 * ActivityBadge for that.
 */
const STATUS_LABEL: Record<SessionStatus, string> = {
	running: "live",
	completed: "done",
	failed: "failed",
};

const STATUS_TITLE: Record<SessionStatus, string> = {
	running: "A pi instance is attached to this session",
	completed: "The pi instance finished this session",
	failed: "The pi instance ended with an error",
};

export function StatusBadge({ status, source, size = "xs", className = "" }: StatusBadgeProps) {
	const badgeSize = size === "sm" ? "badge-sm" : "badge-xs";
	return (
		<span class={`inline-flex items-center gap-1 ${className}`}>
			<span
				class={`badge ${badgeSize} gap-1 ${STATUS_CLASS[status] ?? "badge-ghost"}`}
				title={STATUS_TITLE[status] ?? status}
			>
				{STATUS_LABEL[status] ?? status}
			</span>
			{source === "leech" && (
				<span class="badge badge-ghost badge-xs font-mono" title="Session discovered from a transcript directory">
					leech
				</span>
			)}
		</span>
	);
}

export interface ActivityBadgeProps {
	session: Pick<SessionNode, "busy" | "source" | "status" | "ownerPid">;
	size?: "xs" | "sm";
	className?: string;
}

/**
 * Whether a *message* is running right now, which is a different question from
 * whether the session's pi instance is alive. A live instance sits idle between
 * turns; an idle leech has no instance at all until it is resumed.
 */
export function ActivityBadge({ session, size = "xs", className = "" }: ActivityBadgeProps) {
	const badgeSize = size === "sm" ? "badge-sm" : "badge-xs";
	if (session.busy) {
		return (
			<span
				class={`badge ${badgeSize} gap-1 badge-info ${className}`}
				title="A message is running: the agent is working on a turn right now"
				data-testid="activity-badge"
				data-activity="working"
			>
				<span class="loading loading-spinner loading-xs" aria-hidden="true" />
				working
			</span>
		);
	}
	if (session.source === "live" && session.status === "running") {
		return (
			<span
				class={`badge ${badgeSize} gap-1 badge-ghost ${className}`}
				title="The pi instance is running but no message is in flight"
				data-testid="activity-badge"
				data-activity="idle"
			>
				<span class="size-1.5 rounded-full bg-success/70" aria-hidden="true" />
				idle
			</span>
		);
	}
	if (session.source === "leech" && session.ownerPid !== undefined) {
		return (
			<span
				class={`badge ${badgeSize} gap-1 badge-ghost ${className}`}
				title={`Owned by pi pid ${session.ownerPid}, but no message is in flight`}
				data-testid="activity-badge"
				data-activity="idle"
			>
				idle
			</span>
		);
	}
	return null;
}
