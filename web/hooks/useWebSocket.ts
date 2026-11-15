import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
	ClientToServerMessage,
	DeliverAs,
	PromptResponse,
	ServerState,
	ServerToClientMessage,
	SessionNode,
	SpawnRecord,
	SpawnState,
	WebappEvent,
} from "../../src/protocol.js";
import { EVENT_HISTORY_LIMIT } from "../../src/protocol.js";

/** Request body for `POST /api/spawn`. */
export interface SpawnInput {
	cwd: string;
	prompt?: string;
	model?: string;
	agentName?: string;
}

export interface StartSessionResult {
	ok: boolean;
	error?: string;
	spawn?: SpawnRecord;
}

export interface StopSpawnResult {
	ok: boolean;
	error?: string;
}

export interface WebappConnection {
	status: "connecting" | "open" | "closed";
	connected: boolean;
	state: ServerState | null;
	events: WebappEvent[];
	sessions: SessionNode[];
	/** pi processes launched by this dashboard, newest last. */
	spawns: SpawnRecord[];
	/** False when this instance is not allowed to launch pi processes. */
	spawnEnabled: boolean;
	/** Server-provided default working directory for new sessions. */
	defaultCwd: string;
	error: string | null;
	sendPrompt(sessionId: string, text: string, deliverAs: DeliverAs): Promise<PromptResponse>;
	rescanLeech(): Promise<void>;
	startSession(input: SpawnInput): Promise<StartSessionResult>;
	stopSpawn(spawnId: string): Promise<StopSpawnResult>;
	takeOverSession(sessionId: string, options?: { kill?: boolean }): Promise<TakeOverResult>;
	removeSession(sessionId: string, options?: { deleteFile?: boolean }): Promise<RemoveSessionResult>;
	renameSession(sessionId: string, name: string): Promise<RenameSessionResult>;
	switchModel(sessionId: string, provider: string, modelId: string): Promise<SwitchModelResult>;
}

export interface SwitchModelResult {
	ok: boolean;
	error?: string;
}

export interface RenameSessionResult {
	ok: boolean;
	error?: string;
}

export interface RemoveSessionResult {
	ok: boolean;
	error?: string;
	removed?: string[];
}

export interface TakeOverResult {
	ok: boolean;
	error?: string;
	/** An idle pi process still owns the session; it can be stopped and replaced. */
	needsKill?: boolean;
	/** Pid reported by the server for the owning process. */
	pid?: number;
}

const EMPTY_EVENTS: WebappEvent[] = [];
const EMPTY_SESSIONS: SessionNode[] = [];
const EMPTY_SPAWN_STATE: SpawnState = { enabled: false, spawns: [] };
const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 15_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function websocketUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss" : "ws";
	return `${protocol}://${window.location.host}/ws`;
}

function sortSessions(sessions: SessionNode[]): SessionNode[] {
	return sessions.slice().sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

function sortSpawns(spawns: SpawnRecord[]): SpawnRecord[] {
	return spawns
		.slice()
		.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.spawnId.localeCompare(b.spawnId));
}

function isSpawnRecord(value: unknown): value is SpawnRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as { spawnId?: unknown };
	return typeof record.spawnId === "string" && record.spawnId.length > 0;
}

/** Keeps the UI safe against snapshots from servers without spawn support. */
function normalizeSpawnState(value: unknown): SpawnState {
	if (!value || typeof value !== "object") return EMPTY_SPAWN_STATE;
	const record = value as { enabled?: unknown; spawns?: unknown; defaultCwd?: unknown };
	const spawns = Array.isArray(record.spawns) ? record.spawns.filter(isSpawnRecord) : [];
	return {
		enabled: record.enabled === true,
		spawns: sortSpawns(spawns),
		defaultCwd: typeof record.defaultCwd === "string" ? record.defaultCwd : undefined,
	};
}

function parseServerMessage(raw: string): ServerToClientMessage | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const type = (parsed as { type?: unknown }).type;
		if (
			type === "snapshot" ||
			type === "event" ||
			type === "session" ||
			type === "spawn" ||
			type === "spawns" ||
			type === "session_removed" ||
			type === "session_renamed" ||
			type === "command" ||
			type === "hello_ok" ||
			type === "pong"
		) {
			return parsed as ServerToClientMessage;
		}
		return null;
	} catch {
		return null;
	}
}

function parseStartSessionResponse(payload: unknown, status: number): StartSessionResult {
	if (!payload || typeof payload !== "object") {
		return { ok: false, error: status >= 400 ? `Request failed (${status})` : "Empty response from server" };
	}
	const record = payload as { ok?: unknown; error?: unknown; spawn?: unknown };
	if (record.ok !== true) {
		const message = typeof record.error === "string" && record.error ? record.error : `Request failed (${status})`;
		return { ok: false, error: message };
	}
	return isSpawnRecord(record.spawn) ? { ok: true, spawn: record.spawn } : { ok: true };
}

function parseStopSpawnResponse(payload: unknown, status: number): StopSpawnResult {
	if (!payload || typeof payload !== "object") {
		const failed = status >= 400;
		return failed ? { ok: false, error: `Request failed (${status})` } : { ok: true };
	}
	const record = payload as { ok?: unknown; error?: unknown };
	if (record.ok === true) return { ok: true };
	const message = typeof record.error === "string" && record.error ? record.error : `Request failed (${status})`;
	return { ok: false, error: message };
}

function parsePromptResponse(payload: unknown, status: number): PromptResponse {
	if (!payload || typeof payload !== "object") {
		return { ok: false, error: status >= 400 ? `Request failed (${status})` : "Empty response from server" };
	}
	const record = payload as { ok?: unknown; delivered?: unknown; error?: unknown };
	if (record.ok !== true) {
		const message = typeof record.error === "string" && record.error ? record.error : `Request failed (${status})`;
		return { ok: false, error: message };
	}
	const delivered = record.delivered === "local" || record.delivered === "instance" ? record.delivered : undefined;
	return delivered ? { ok: true, delivered } : { ok: true };
}

export function useWebSocket(): WebappConnection {
	const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
	const [state, setState] = useState<ServerState | null>(null);
	const [spawnState, setSpawnState] = useState<SpawnState>(EMPTY_SPAWN_STATE);
	const [error, setError] = useState<string | null>(null);
	const seenIds = useRef<Set<string>>(new Set());

	const replaceState = useCallback((next: ServerState | null) => {
		if (!next || typeof next !== "object") return;
		const sessions = sortSessions(Array.isArray(next.sessions) ? next.sessions : []);
		const events = (Array.isArray(next.events) ? next.events : []).slice(-EVENT_HISTORY_LIMIT);
		seenIds.current = new Set(events.map((event) => event.id));
		setState({ ...next, sessions, events });
		setSpawnState(normalizeSpawnState((next as { spawn?: unknown }).spawn));
	}, []);

	const appendEvent = useCallback((event: WebappEvent | null | undefined) => {
		if (!event || typeof event.id !== "string" || event.id.length === 0) return;
		if (seenIds.current.has(event.id)) return;
		seenIds.current.add(event.id);
		const normalized: WebappEvent = {
			...event,
			data: event.data && typeof event.data === "object" ? event.data : {},
		};
		setState((previous) => {
			if (!previous) return previous;
			let events = [...previous.events, normalized];
			if (events.length > EVENT_HISTORY_LIMIT) {
				events = events.slice(events.length - EVENT_HISTORY_LIMIT);
				seenIds.current = new Set(events.map((item) => item.id));
			}
			return { ...previous, events };
		});
	}, []);

	const upsertSession = useCallback((session: SessionNode | null | undefined) => {
		if (!session || typeof session.id !== "string") return;
		setState((previous) => {
			if (!previous) return previous;
			const existing = previous.sessions.some((item) => item.id === session.id);
			const merged = existing
				? previous.sessions.map((item) => (item.id === session.id ? { ...item, ...session } : item))
				: [...previous.sessions, session];
			const sessions = sortSessions(merged);
			return {
				...previous,
				sessions,
				counts: {
					...previous.counts,
					sessions: sessions.length,
					subagents: sessions.filter((item) => item.isSubagent).length,
				},
			};
		});
	}, []);

	const upsertSpawn = useCallback((spawn: SpawnRecord | null | undefined) => {
		if (!isSpawnRecord(spawn)) return;
		const record = spawn;
		setSpawnState((previous) => {
			const exists = previous.spawns.some((item) => item.spawnId === record.spawnId);
			const spawns = exists
				? previous.spawns.map((item) => (item.spawnId === record.spawnId ? { ...item, ...record } : item))
				: [...previous.spawns, record];
			return { ...previous, spawns: sortSpawns(spawns) };
		});
	}, []);

	const refreshState = useCallback(async () => {
		try {
			const response = await fetch("/api/state", {
				headers: { accept: "application/json" },
				cache: "no-store",
			});
			if (!response.ok) throw new Error(`GET /api/state failed (${response.status})`);
			const payload: unknown = await response.json();
			replaceState(payload as ServerState);
			setError(null);
		} catch (err) {
			setError(errorMessage(err));
		}
	}, [replaceState]);

	useEffect(() => {
		let disposed = false;
		let socket: WebSocket | null = null;
		let reconnectTimer: number | null = null;
		let attempt = 0;

		function scheduleReconnect(): void {
			if (disposed || reconnectTimer !== null) return;
			const base = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * 2 ** Math.min(attempt, 4));
			attempt += 1;
			const delay = Math.round(base * (0.75 + Math.random() * 0.5));
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = null;
				connect();
			}, delay);
		}

		function connect(): void {
			if (disposed) return;
			if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
			setStatus("connecting");
			let nextSocket: WebSocket;
			try {
				nextSocket = new WebSocket(websocketUrl());
			} catch (err) {
				setStatus("closed");
				setError(errorMessage(err));
				scheduleReconnect();
				return;
			}
			socket = nextSocket;
			nextSocket.onopen = () => {
				if (disposed) return;
				attempt = 0;
				setStatus("open");
				setError(null);
				const hello: ClientToServerMessage = { type: "hello", role: "ui" };
				nextSocket.send(JSON.stringify(hello));
			};
			nextSocket.onmessage = (messageEvent: MessageEvent) => {
				if (disposed || typeof messageEvent.data !== "string") return;
				const message = parseServerMessage(messageEvent.data);
				if (!message) return;
				if (message.type === "snapshot") replaceState(message.state);
				else if (message.type === "event") appendEvent(message.event);
				else if (message.type === "session") upsertSession(message.session);
				else if (message.type === "spawn") upsertSpawn(message.spawn);
				else if (message.type === "spawns") setSpawnState(normalizeSpawnState(message.state));
				else if (message.type === "session_renamed") {
					const { sessionId, name } = message;
					setState((previous) =>
						previous
							? {
									...previous,
									sessions: previous.sessions.map((session) => {
										if (session.id !== sessionId) return session;
										const next = { ...session };
										if (name) next.customName = name;
										else delete next.customName;
										return next;
									}),
								}
							: previous,
					);
				} else if (message.type === "plugins") {
					setState((previous) => (previous ? { ...previous, plugins: message.plugins } : previous));
				} else if (message.type === "models") {
					setState((previous) => (previous ? { ...previous, models: message.models } : previous));
				} else if (message.type === "session_removed") {
					const removed = new Set(message.sessionIds);
					setState((previous) =>
						previous
							? {
									...previous,
									sessions: previous.sessions.filter((session) => !removed.has(session.id)),
									events: previous.events.filter((event) => !removed.has(event.sessionId)),
								}
							: previous,
					);
				}
			};
			nextSocket.onerror = () => {
				if (disposed) return;
				setError("WebSocket connection error");
				if (nextSocket.readyState === WebSocket.CLOSED) scheduleReconnect();
			};
			nextSocket.onclose = () => {
				if (socket === nextSocket) socket = null;
				if (disposed) return;
				setStatus("closed");
				scheduleReconnect();
			};
		}

		function reconnectNow(): void {
			if (disposed) return;
			if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			attempt = 0;
			connect();
		}

		const handleOnline = () => reconnectNow();
		const handleVisibility = () => {
			if (document.visibilityState === "visible") reconnectNow();
		};

		window.addEventListener("online", handleOnline);
		document.addEventListener("visibilitychange", handleVisibility);
		void refreshState().finally(() => {
			if (!disposed) connect();
		});

		return () => {
			disposed = true;
			window.removeEventListener("online", handleOnline);
			document.removeEventListener("visibilitychange", handleVisibility);
			if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
			reconnectTimer = null;
			if (socket) {
				socket.onopen = null;
				socket.onmessage = null;
				socket.onerror = null;
				socket.onclose = null;
				socket.close();
				socket = null;
			}
		};
	}, [appendEvent, refreshState, replaceState, upsertSession, upsertSpawn]);

	const switchModel = useCallback(
		async (sessionId: string, provider: string, modelId: string): Promise<SwitchModelResult> => {
			try {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ provider, modelId }),
				});
				let payload: unknown = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				if (payload && typeof payload === "object") {
					const record = payload as Record<string, unknown>;
					if (record.ok === true) return { ok: true };
					const error = typeof record.error === "string" ? record.error : undefined;
					if (error) return { ok: false, error };
				}
				return { ok: false, error: `switch failed (status ${response.status})` };
			} catch (err) {
				return { ok: false, error: errorMessage(err) };
			}
		},
		[],
	);

	const sendPrompt = useCallback(
		async (sessionId: string, text: string, deliverAs: DeliverAs): Promise<PromptResponse> => {
			try {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ text, deliverAs }),
				});
				let payload: unknown = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				return parsePromptResponse(payload, response.status);
			} catch (err) {
				return { ok: false, error: errorMessage(err) };
			}
		},
		[],
	);

	const startSession = useCallback(
		async (input: SpawnInput): Promise<StartSessionResult> => {
			const body: Record<string, string> = { cwd: input.cwd };
			const prompt = input.prompt?.trim();
			const model = input.model?.trim();
			const agentName = input.agentName?.trim();
			if (prompt) body.prompt = prompt;
			if (model) body.model = model;
			if (agentName) body.agentName = agentName;
			try {
				const response = await fetch("/api/spawn", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(body),
				});
				let payload: unknown = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				const result = parseStartSessionResponse(payload, response.status);
				if (result.ok && result.spawn) upsertSpawn(result.spawn);
				return result;
			} catch (err) {
				return { ok: false, error: errorMessage(err) };
			}
		},
		[upsertSpawn],
	);

	const stopSpawn = useCallback(async (spawnId: string): Promise<StopSpawnResult> => {
		try {
			const response = await fetch(`/api/spawn/${encodeURIComponent(spawnId)}`, {
				method: "DELETE",
				headers: { accept: "application/json" },
			});
			let payload: unknown = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			return parseStopSpawnResponse(payload, response.status);
		} catch (err) {
			return { ok: false, error: errorMessage(err) };
		}
	}, []);

	const takeOverSession = useCallback(
		async (sessionId: string, options: { kill?: boolean } = {}): Promise<TakeOverResult> => {
			try {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/takeover`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ kill: options.kill === true }),
				});
				let payload: unknown = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
				if (response.ok) return { ok: true };
				const message = typeof record.error === "string" ? record.error : `Request failed (${response.status})`;
				return {
					ok: false,
					error: message,
					needsKill: record.code === "owner-running" && record.canKill === true,
					pid: typeof record.pid === "number" ? record.pid : undefined,
				};
			} catch (err) {
				return { ok: false, error: errorMessage(err) };
			}
		},
		[],
	);

	const removeSession = useCallback(
		async (sessionId: string, options: { deleteFile?: boolean } = {}): Promise<RemoveSessionResult> => {
			try {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
					method: "DELETE",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ deleteFile: options.deleteFile === true }),
				});
				let payload: unknown = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
				if (!response.ok) {
					return { ok: false, error: typeof record.error === "string" ? record.error : `Request failed (${response.status})` };
				}
				return {
					ok: true,
					removed: Array.isArray(record.removed) ? record.removed.filter((id): id is string => typeof id === "string") : [],
				};
			} catch (err) {
				return { ok: false, error: errorMessage(err) };
			}
		},
		[],
	);

	const renameSession = useCallback(
		async (sessionId: string, name: string): Promise<RenameSessionResult> => {
			try {
				const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ name }),
				});
				let payload: unknown = null;
				try {
					payload = await response.json();
				} catch {
					payload = null;
				}
				const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
				if (!response.ok) {
					return { ok: false, error: typeof record.error === "string" ? record.error : `Request failed (${response.status})` };
				}
				return { ok: true };
			} catch (err) {
				return { ok: false, error: errorMessage(err) };
			}
		},
		[],
	);

	const rescanLeech = useCallback(async (): Promise<void> => {
		try {
			const response = await fetch("/api/leech/scan", {
				method: "POST",
				headers: { accept: "application/json" },
			});
			if (!response.ok) throw new Error(`POST /api/leech/scan failed (${response.status})`);
			await refreshState();
		} catch (err) {
			setError(errorMessage(err));
		}
	}, [refreshState]);

	return {
		status,
		connected: status === "open",
		state,
		events: state?.events ?? EMPTY_EVENTS,
		sessions: state?.sessions ?? EMPTY_SESSIONS,
		spawns: spawnState.spawns,
		spawnEnabled: spawnState.enabled,
		defaultCwd: spawnState.defaultCwd ?? "",
		error,
		sendPrompt,
		rescanLeech,
		startSession,
		stopSpawn,
		takeOverSession,
		removeSession,
		renameSession,
		switchModel,
	};
}
