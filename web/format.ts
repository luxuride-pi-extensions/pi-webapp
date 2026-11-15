import type { SessionNode } from "../src/protocol.js";

function lastSegment(value: string): string {
	const parts = value.split("/").filter(Boolean);
	return parts.length > 0 ? (parts[parts.length - 1] ?? value) : value;
}

/**
 * Human label for a session: an operator rename wins, then the subagent role,
 * then the project folder. Ids are appended only as a tie-breaker (see
 * `uniqueSessionName`) so the sidebar stays readable at a glance.
 */
export function sessionName(session: SessionNode): string {
	const custom = session.customName?.trim();
	if (custom) return custom;
	const agent = session.agentName?.trim();
	if (agent && agent !== "session") return agent;
	const short = session.id.slice(0, 8);
	if (session.isSubagent) return `subagent ${short}`;
	const folder = session.cwd ? lastSegment(session.cwd) : lastSegment(session.title ?? "");
	if (folder && folder !== "." && folder !== "/") return folder;
	return `session ${short}`;
}

/** Appends the short id when several sessions would otherwise share a label. */
export function uniqueSessionName(session: SessionNode, siblings: readonly SessionNode[]): string {
	const name = sessionName(session);
	const clashes = siblings.filter((other) => other.id !== session.id && sessionName(other) === name);
	return clashes.length > 0 ? `${name} · ${session.id.slice(0, 8)}` : name;
}

/** Longer label used in confirmations: name plus the transcript title. */
export function sessionDescription(session: SessionNode): string {
	const name = sessionName(session);
	const title = session.title?.trim();
	return title ? `${name} — ${title}` : name;
}
