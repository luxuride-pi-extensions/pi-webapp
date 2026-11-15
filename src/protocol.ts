/**
 * Shared wire protocol between the pi extension, the dashboard server and the
 * Preact frontend. Keep this module dependency-free so it can be imported from
 * the browser bundle as well as from Node.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const CACHE_DIR_NAME = "pi-wabapp";
export const EVENT_HISTORY_LIMIT = 4000;
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
export const WATCH_INTERVAL_MS = 1500;

/** Environment variables understood by the extension and by child pi processes. */
export const ENV = {
	host: "PI_WABAPP_HOST",
	port: "PI_WABAPP_PORT",
	cacheDir: "PI_WABAPP_CACHE_DIR",
	leech: "PI_WABAPP_LEECH",
	leechDir: "PI_WABAPP_LEECH_DIR",
	playwright: "PI_WABAPP_PLAYWRIGHT",
	/** Propagated into child `pi` processes spawned as subagents. */
	parentSessionId: "PI_WABAPP_PARENT_SESSION_ID",
	agentName: "PI_WABAPP_AGENT_NAME",
	/** Common aliases used by out-of-process subagent launchers. */
	legacyParentSessionId: "PI_PARENT_SESSION_ID",
	legacyAgentName: "PI_SUBAGENT_NAME",
} as const;

/** Tool names that delegate work to a subagent (out-of-process or in-process). */
export const SUBAGENT_TOOL_NAMES: readonly string[] = [
	"subagent",
	"subagents",
	"Agent",
	"SubagentWorkflow",
	"Task",
	"spawn_agent",
	"spawn_subagent",
];

export function isSubagentToolName(name: string): boolean {
	return SUBAGENT_TOOL_NAMES.includes(name);
}

export type SessionStatus = "running" | "completed" | "failed";
export type SessionSource = "live" | "leech";

export type WabappEventType =
	| "session_started"
	| "session_ended"
	| "session_meta"
	| "agent_start"
	| "agent_end"
	| "user_prompt"
	| "assistant_message"
	| "tool_start"
	| "tool_end"
	| "subagent_spawned"
	| "subagent_completed"
	| "work_state"
	| "error";

export type MediaKind = "image" | "video";

export interface MediaAsset {
	kind: MediaKind;
	/** Server-relative URL below `/artifacts/`. */
	url: string;
	filename: string;
	bytes: number;
	mime: string;
}

export type WabappEventData = Record<string, unknown>;

export interface WabappEvent {
	id: string;
	type: WabappEventType;
	/** Session that produced the event. For subagent events this is the child. */
	sessionId: string;
	/** Root/parent session, used to bubble subagent activity into the parent feed. */
	parentSessionId?: string;
	agentName?: string;
	isSubagent?: boolean;
	source?: SessionSource;
	timestamp: number;
	data: WabappEventData;
}

export interface SessionNode {
	id: string;
	parentSessionId?: string;
	agentName?: string;
	title?: string;
	cwd?: string;
	model?: string;
	status: SessionStatus;
	source: SessionSource;
	isSubagent: boolean;
	startedAt: number;
	updatedAt: number;
	endedAt?: number;
	/** Task prompt for subagents. */
	task?: string;
	sessionFile?: string;
	lastEventType?: WabappEventType;
}

export interface LeechStatus {
	enabled: boolean;
	running: boolean;
	dirs: string[];
	files: number;
	sessions: number;
	lastScanAt?: number;
	lastError?: string;
}

export interface ServerState {
	sessions: SessionNode[];
	events: WabappEvent[];
	counts: { sessions: number; subagents: number; events: number };
	leech: LeechStatus;
	serverTime: number;
}

export type DeliverAs = "auto" | "steer" | "followUp";

export interface PromptCommand {
	id: string;
	sessionId: string;
	text: string;
	deliverAs: DeliverAs;
	createdAt: number;
	/** pi instance that owns the session, when known. */
	instanceId?: string;
}

export interface PromptResponse {
	ok: boolean;
	delivered?: "local" | "instance";
	error?: string;
}

export type ServerToClientMessage =
	| { type: "snapshot"; state: ServerState }
	| { type: "event"; event: WabappEvent }
	| { type: "session"; session: SessionNode }
	| { type: "command"; command: PromptCommand }
	| { type: "hello_ok"; instanceId: string }
	| { type: "pong" };

export type ClientToServerMessage =
	| { type: "hello"; role: "ui" | "instance"; instanceId?: string }
	| { type: "command_ack"; commandId: string; ok: boolean; error?: string }
	| { type: "ping" };

export function makeEvent(input: {
	type: WabappEventType;
	sessionId: string;
	parentSessionId?: string;
	agentName?: string;
	isSubagent?: boolean;
	source?: SessionSource;
	timestamp?: number;
	data?: WabappEventData;
}): WabappEvent {
	const event: WabappEvent = {
		id: newId("evt"),
		type: input.type,
		sessionId: input.sessionId,
		timestamp: input.timestamp ?? Date.now(),
		data: input.data ?? {},
	};
	if (input.parentSessionId) event.parentSessionId = input.parentSessionId;
	if (input.agentName) event.agentName = input.agentName;
	if (input.isSubagent) event.isSubagent = true;
	if (input.source) event.source = input.source;
	return event;
}

export function newId(prefix = "id"): string {
	const bytes = new Uint8Array(8);
	const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
	if (cryptoObj?.getRandomValues) {
		cryptoObj.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	return `${prefix}_${Date.now().toString(36)}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 3) return text.slice(0, max);
	return `${text.slice(0, max - 1)}…`;
}

/** Read a string field from an untyped event payload. */
export function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function mediaList(value: unknown): MediaAsset[] {
	if (!Array.isArray(value)) return [];
	const out: MediaAsset[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const kind = record.kind === "video" ? "video" : record.kind === "image" ? "image" : null;
		const url = str(record.url);
		if (!kind || !url) continue;
		out.push({
			kind,
			url,
			filename: str(record.filename, url.split("/").pop() ?? "artifact"),
			bytes: num(record.bytes),
			mime: str(record.mime, kind === "video" ? "video/webm" : "image/png"),
		});
	}
	return out;
}

/** True when `candidate` resolves to `root` or something below it. */
export function isPathInside(root: string, candidate: string): boolean {
	const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
