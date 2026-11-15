/**
 * Shared wire protocol between the pi extension, the dashboard server and the
 * Preact frontend. Keep this module dependency-free so it can be imported from
 * the browser bundle as well as from Node.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const CACHE_DIR_NAME = "pi-webapp";
export const EVENT_HISTORY_LIMIT = 4000;
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
export const WATCH_INTERVAL_MS = 1500;

/** Environment variables understood by the extension and by child pi processes. */
export const ENV = {
	host: "PI_WEBAPP_HOST",
	port: "PI_WEBAPP_PORT",
	cacheDir: "PI_WEBAPP_CACHE_DIR",
	leech: "PI_WEBAPP_LEECH",
	leechDir: "PI_WEBAPP_LEECH_DIR",
	leechMaxAge: "PI_WEBAPP_LEECH_MAX_AGE_MS",
	playwright: "PI_WEBAPP_PLAYWRIGHT",
	/** Set to 0 to forbid the dashboard from launching pi processes. */
	spawn: "PI_WEBAPP_SPAWN",
	/** Overrides the `pi` executable used for dashboard-spawned sessions. */
	piBin: "PI_WEBAPP_PI_BIN",
	/** Extra `--session-dir` for spawned sessions. */
	sessionDir: "PI_WEBAPP_SESSION_DIR",
	/** Identifies a session started by the dashboard (read by the child pi). */
	spawnId: "PI_WEBAPP_SPAWN_ID",
	/** Set to 0 to skip the systemd user service integration. */
	autostart: "PI_WEBAPP_AUTOSTART",
	/** Overrides the systemd unit name (tests use a throwaway unit). */
	systemdUnit: "PI_WEBAPP_SYSTEMD_UNIT",
	/** Propagated into child `pi` processes spawned as subagents. */
	parentSessionId: "PI_WEBAPP_PARENT_SESSION_ID",
	agentName: "PI_WEBAPP_AGENT_NAME",
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

export type WebappEventType =
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

export type WebappEventData = Record<string, unknown>;

export interface WebappEvent {
	id: string;
	type: WebappEventType;
	/** Session that produced the event. For subagent events this is the child. */
	sessionId: string;
	/** Root/parent session, used to bubble subagent activity into the parent feed. */
	parentSessionId?: string;
	agentName?: string;
	isSubagent?: boolean;
	source?: SessionSource;
	timestamp: number;
	data: WebappEventData;
}

export interface SessionNode {
	id: string;
	parentSessionId?: string;
	agentName?: string;
	/** Operator-provided label; overrides the agent name everywhere in the UI. */
	customName?: string;
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
	lastEventType?: WebappEventType;
	/** Set when the dashboard launched this session's pi process. */
	spawnId?: string;
	/** PID of the `pi` process that currently owns this session, when detectable. */
	ownerPid?: number;
	/** True while that process appears to be in the middle of a turn. */
	ownerBusy?: boolean;
	/** Spawn created by a "take over" request, until the resumed session registers. */
	takeoverSpawnId?: string;
}

export type SpawnStatus = "starting" | "running" | "exited" | "failed";

/** Request body accepted by `POST /api/spawn`. */
export interface SpawnRequest {
	cwd: string;
	prompt?: string;
	model?: string;
	agentName?: string;
	sessionFile?: string;
	extraArgs?: string[];
	/** Set for takeover spawns: the session id this process must register as. */
	targetSessionId?: string;
}

/** A pi process started by the dashboard ("New session"). */
export interface SpawnRecord {
	spawnId: string;
	pid?: number;
	cwd: string;
	status: SpawnStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	sessionId?: string;
	prompt?: string;
	model?: string;
	agentName?: string;
	sessionFile?: string;
	logFile?: string;
	error?: string;
	/** Set for takeover spawns: the session id this process must register as. */
	targetSessionId?: string;
	/** PID stopped to free the session, when a takeover had to kill a process. */
	killedPid?: number;
}

export interface SpawnState {
	enabled: boolean;
	spawns: SpawnRecord[];
	/** Working directory used when a spawn request omits one. */
	defaultCwd?: string;
}

/** Structural contract implemented by `SessionSpawner` (src/spawn.ts). */
export interface SessionSpawnerLike {
	readonly available: boolean;
	readonly enabled: boolean;
	readonly piBin: string;
	readonly defaultWorkingDir: string;
	spawn(request: SpawnRequest): Promise<SpawnRecord>;
	stop(spawnId: string): boolean;
	list(): SpawnRecord[];
	get(spawnId: string): SpawnRecord | null;
	attachSession(spawnId: string, sessionId: string): void;
	logTail(spawnId: string, maxBytes?: number): string | null;
	stopAll(): void;
}

export interface LeechStatus {
	enabled: boolean;
	running: boolean;
	dirs: string[];
	files: number;
	sessions: number;
	/** Sessions skipped because they are stale and no live pi process owns them. */
	skippedStale: number;
	/** Freshness window for a session file without an owning process. */
	maxAgeMs: number;
	lastScanAt?: number;
	lastError?: string;
}

export interface ServerState {
	sessions: SessionNode[];
	events: WebappEvent[];
	counts: { sessions: number; subagents: number; events: number };
	leech: LeechStatus;
	/** Dashboard-launched pi processes and whether spawning is allowed. */
	spawn: SpawnState;
	/** Models reported by the attached pi instances (empty when none). */
	models: ModelInfo[];
	/** Panels contributed by other extensions. */
	plugins: PluginInfo[];
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

/** A dashboard panel contributed by another pi extension. */
export interface PluginPanel {
	id: string;
	title: string;
	/** File served from the plugin's own directory. */
	entry: string;
	height?: number;
	description?: string;
}

export interface PluginInfo {
	id: string;
	name: string;
	version?: string;
	description?: string;
	panels: PluginPanel[];
	/** Event types this plugin wants to see, e.g. ["todo"] for a todo panel. */
	events?: string[];
	registeredAt: number;
}

/** One model the connected pi instances can switch a session to. */
export interface ModelInfo {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelCommand {
	id: string;
	sessionId: string;
	provider: string;
	modelId: string;
	createdAt: number;
	/** pi instance that owns the session, when known. */
	instanceId?: string;
}

export type ServerToClientMessage =
	| { type: "snapshot"; state: ServerState }
	| { type: "event"; event: WebappEvent }
	| { type: "session"; session: SessionNode }
	| { type: "spawn"; spawn: SpawnRecord }
	| { type: "spawns"; state: SpawnState }
	| { type: "session_removed"; sessionIds: string[] }
	| { type: "session_renamed"; sessionId: string; name?: string }
	| { type: "command"; command: PromptCommand }
	| { type: "model_command"; command: ModelCommand }
	| { type: "models"; models: ModelInfo[] }
	| { type: "plugins"; plugins: PluginInfo[] }
	| { type: "hello_ok"; instanceId: string }
	| { type: "pong" };

export type ClientToServerMessage =
	| { type: "hello"; role: "ui" | "instance"; instanceId?: string }
	| { type: "command_ack"; commandId: string; ok: boolean; error?: string }
	| { type: "model_command_ack"; commandId: string; ok: boolean; error?: string }
	| { type: "models"; models: ModelInfo[] }
	| { type: "ping" };

export function makeEvent(input: {
	type: WebappEventType;
	sessionId: string;
	parentSessionId?: string;
	agentName?: string;
	isSubagent?: boolean;
	source?: SessionSource;
	timestamp?: number;
	data?: WebappEventData;
}): WebappEvent {
	const event: WebappEvent = {
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
