import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type {
	ClientToServerMessage,
	DeliverAs,
	PromptResponse,
	ServerState,
	ServerToClientMessage,
	SessionNode,
	WabappEvent,
} from "../../src/protocol.js";
import { EVENT_HISTORY_LIMIT } from "../../src/protocol.js";

export interface WabappConnection {
	status: "connecting" | "open" | "closed";
	connected: boolean;
	state: ServerState | null;
	events: WabappEvent[];
	sessions: SessionNode[];
	error: string | null;
	sendPrompt(sessionId: string, text: string, deliverAs: DeliverAs): Promise<PromptResponse>;
	rescanLeech(): Promise<void>;
}

const EMPTY_EVENTS: WabappEvent[] = [];
const EMPTY_SESSIONS: SessionNode[] = [];
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

function parseServerMessage(raw: string): ServerToClientMessage | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const type = (parsed as { type?: unknown }).type;
		if (
			type === "snapshot" ||
			type === "event" ||
			type === "session" ||
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

export function useWebSocket(): WabappConnection {
	const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
	const [state, setState] = useState<ServerState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const seenIds = useRef<Set<string>>(new Set());

	const replaceState = useCallback((next: ServerState | null) => {
		if (!next || typeof next !== "object") return;
		const sessions = sortSessions(Array.isArray(next.sessions) ? next.sessions : []);
		const events = (Array.isArray(next.events) ? next.events : []).slice(-EVENT_HISTORY_LIMIT);
		seenIds.current = new Set(events.map((event) => event.id));
		setState({ ...next, sessions, events });
	}, []);

	const appendEvent = useCallback((event: WabappEvent | null | undefined) => {
		if (!event || typeof event.id !== "string" || event.id.length === 0) return;
		if (seenIds.current.has(event.id)) return;
		seenIds.current.add(event.id);
		const normalized: WabappEvent = {
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
	}, [appendEvent, refreshState, replaceState, upsertSession]);

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
		error,
		sendPrompt,
		rescanLeech,
	};
}
