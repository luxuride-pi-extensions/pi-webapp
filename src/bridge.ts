import { WabappClient } from "./client.js";
import type { LeechStatus, PromptCommand, WabappEvent } from "./protocol.js";
import { WabappServer } from "./server.js";
import type { LocalPromptHandler } from "./server.js";
import { pruneArtifacts } from "./storage.js";

export interface BridgeOptions {
	instanceId: string;
	host: string;
	port: number;
}

export interface BridgeRuntime {
	mode: "primary" | "client";
	url: string;
	emit(event: WabappEvent): void;
	setPromptHandler(handler: LocalPromptHandler | null): void;
	rescanLeech(dirs?: string[]): Promise<LeechStatus>;
	getLeechStatus(): Promise<LeechStatus> | LeechStatus;
	shutdown(): Promise<void>;
}

const PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LEECH_TIMEOUT_MS = 10_000;

function isAddressInUse(error: unknown): boolean {
	const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
	if (code === "EADDRINUSE") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /EADDRINUSE|address already in use/i.test(message);
}

function toLeechStatus(value: unknown): LeechStatus {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const dirs = Array.isArray(record.dirs)
		? record.dirs.filter((dir): dir is string => typeof dir === "string")
		: [];
	const status: LeechStatus = {
		enabled: record.enabled === true,
		running: record.running === true,
		dirs,
		files: typeof record.files === "number" ? record.files : 0,
		sessions: typeof record.sessions === "number" ? record.sessions : 0,
	};
	if (typeof record.lastScanAt === "number") status.lastScanAt = record.lastScanAt;
	if (typeof record.lastError === "string") status.lastError = record.lastError;
	return status;
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(LEECH_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`pi-wabapp: request to ${url} failed with status ${response.status}`);
	}
	return response.json();
}

async function createClientBridge(
	options: BridgeOptions,
	handlerRef: { current: LocalPromptHandler | null },
): Promise<BridgeRuntime> {
	const baseUrl = `http://${options.host}:${options.port}`;
	const client = new WabappClient({
		baseUrl,
		instanceId: options.instanceId,
		onCommand: async (command: PromptCommand) => {
			const handler = handlerRef.current;
			if (!handler) return { ok: false, error: "No prompt handler is registered" };
			try {
				const handled = await handler(command);
				return handled
					? { ok: true }
					: { ok: false, error: "The session is not owned by this pi instance" };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	});
	client.start();

	let stopped = false;
	return {
		mode: "client",
		url: baseUrl,
		emit(event: WabappEvent) {
			client.emit(event);
		},
		setPromptHandler(handler: LocalPromptHandler | null) {
			handlerRef.current = handler;
		},
		async rescanLeech(dirs?: string[]): Promise<LeechStatus> {
			const body = await requestJson(`${baseUrl}/api/leech/scan`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ dirs }),
			});
			return toLeechStatus(body);
		},
		async getLeechStatus(): Promise<LeechStatus> {
			try {
				return toLeechStatus(await requestJson(`${baseUrl}/api/leech`, { method: "GET" }));
			} catch {
				const body = await requestJson(`${baseUrl}/api/leech`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				return toLeechStatus(body);
			}
		},
		async shutdown(): Promise<void> {
			if (stopped) return;
			stopped = true;
			try {
				await client.stop();
			} catch {
				// shutdown is best effort
			}
		},
	};
}

export async function createBridge(options: BridgeOptions): Promise<BridgeRuntime> {
	const server = new WabappServer({ host: options.host, port: options.port });
	try {
		await server.start();
	} catch (error) {
		try {
			await server.stop();
		} catch {
			// listen failed before the server owned any resources
		}
		if (!isAddressInUse(error)) throw error;
		return createClientBridge(options, {
			current: null,
		});
	}

	try {
		const pruning = pruneArtifacts(server.artifactsRoot, PRUNE_MAX_AGE_MS);
		void Promise.resolve(pruning).catch(() => {});
	} catch {
		// pruning old artifacts is optional
	}

	let stopped = false;
	return {
		mode: "primary",
		url: server.url,
		emit(event: WabappEvent) {
			server.ingest(event);
		},
		setPromptHandler(handler: LocalPromptHandler | null) {
			server.setLocalPromptHandler(handler);
		},
		rescanLeech(dirs?: string[]): Promise<LeechStatus> {
			return server.rescanLeech(dirs);
		},
		getLeechStatus(): LeechStatus {
			return server.getLeechStatus();
		},
		async shutdown(): Promise<void> {
			if (stopped) return;
			stopped = true;
			try {
				await server.stop();
			} catch {
				// shutdown is best effort
			}
		},
	};
}
