import type { SessionSource, SessionStatus } from "../../src/protocol.js";

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

const STATUS_LABEL: Record<SessionStatus, string> = {
	running: "running",
	completed: "completed",
	failed: "failed",
};

export function StatusBadge({ status, source, size = "xs", className = "" }: StatusBadgeProps) {
	const badgeSize = size === "sm" ? "badge-sm" : "badge-xs";
	return (
		<span class={`inline-flex items-center gap-1 ${className}`}>
			<span class={`badge ${badgeSize} gap-1 ${STATUS_CLASS[status] ?? "badge-ghost"}`}>
				{status === "running" && <span class="size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />}
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
