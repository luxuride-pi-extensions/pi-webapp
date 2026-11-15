/**
 * Launches `pi` sessions on behalf of the dashboard.
 *
 * A spawned session runs `pi --mode rpc`, which keeps the process alive and
 * waiting for input instead of exiting after one turn. Prompts are *not* sent
 * over the RPC channel: the child pi loads this extension, joins the dashboard
 * as a normal instance, and receives prompts through the regular WebSocket
 * command path. The RPC channel is only drained (and logged) so pi never blocks
 * on a full stdout pipe.
 *
 * Spawning is a privileged operation: only the primary instance that owns the
 * HTTP server can do it, and it is disabled when the server is not bound to a
 * loopback address.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, type WriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ENV, type SpawnRecord, type SpawnRequest } from "./protocol.js";
import { getCacheRoot } from "./storage.js";

const LOG_TAIL_BYTES = 16 * 1024;
const MAX_RECORDS = 50;
const KILL_GRACE_MS = 4_000;
const MAX_EXTRA_ARGS = 24;
const MAX_PROMPT_LENGTH = 100_000;

export interface SessionSpawnerOptions {
	/** Package root, used to describe where spawned sessions come from. */
	rootDir?: string;
	/** Base URL of the running dashboard, propagated to the child. */
	baseUrl: string;
	/** `pi` executable. Defaults to $PI_WEBAPP_PI_BIN, then `pi`. */
	bin?: string;
	/** Default working directory when the request omits one. */
	cwd?: string;
	/** Optional `--session-dir` for spawned sessions. */
	sessionDir?: string;
	/** Directory for spawn logs. Defaults to `<cache>/spawns`. */
	logDir?: string;
	/** Extra environment for every spawned session. */
	env?: Record<string, string>;
	/** Called whenever a record changes (start, session attach, exit). */
	onChange?: (record: SpawnRecord) => void;
}

export class SpawnError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface LiveSpawn {
	record: SpawnRecord;
	child: ChildProcess;
	log: WriteStream | null;
	killTimer: ReturnType<typeof setTimeout> | null;
	tail: string;
	/** Set when the dashboard asked the process to stop. */
	stopping: boolean;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw new SpawnError(400, `${field} must be a string`);
	return value.trim() || undefined;
}

function isLoopbackHost(host: string): boolean {
	const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1";
}

export function isLoopbackUrl(url: string): boolean {
	try {
		return isLoopbackHost(new URL(url).hostname);
	} catch {
		return false;
	}
}

export function defaultPiBin(): string {
	const fromEnv = process.env[ENV.piBin];
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	const candidates = [
		path.join(homedir(), ".pi", "agent", "bin", "pi"),
		"/usr/local/bin/pi",
		"/usr/bin/pi",
	];
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// ignore
		}
	}
	return "pi";
}

export function parseSpawnRequest(payload: unknown, fallbackCwd: string): SpawnRequest {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new SpawnError(400, "expected a JSON object body");
	}
	const record = payload as Record<string, unknown>;
	const cwd = optionalString(record.cwd, "cwd") ?? fallbackCwd;
	if (!path.isAbsolute(cwd)) throw new SpawnError(400, "cwd must be an absolute path");
	let stats;
	try {
		stats = statSync(cwd);
	} catch {
		throw new SpawnError(400, `cwd does not exist: ${cwd}`);
	}
	if (!stats.isDirectory()) throw new SpawnError(400, `cwd is not a directory: ${cwd}`);

	const prompt = optionalString(record.prompt, "prompt");
	if (prompt && prompt.length > MAX_PROMPT_LENGTH) {
		throw new SpawnError(400, `prompt must be at most ${MAX_PROMPT_LENGTH} characters`);
	}
	const model = optionalString(record.model, "model");
	const agentName = optionalString(record.agentName, "agentName");
	const sessionFile = optionalString(record.sessionFile, "sessionFile");
	const extraArgs = Array.isArray(record.extraArgs)
		? record.extraArgs.map((value, index) => {
				if (typeof value !== "string" || value.trim().length === 0) {
					throw new SpawnError(400, `extraArgs[${index}] must be a non-empty string`);
				}
				return value.trim();
			})
		: [];
	if (extraArgs.length > MAX_EXTRA_ARGS) {
		throw new SpawnError(400, `extraArgs supports at most ${MAX_EXTRA_ARGS} entries`);
	}

	return { cwd, prompt, model, agentName, sessionFile, extraArgs };
}

export class SessionSpawner {
	readonly available: boolean;
	readonly rootDir: string;
	readonly baseUrl: string;

	private readonly bin: string;
	private readonly defaultCwd: string;
	private readonly sessionDir: string | undefined;
	private readonly logDir: string;
	private readonly extraEnv: Record<string, string>;
	private readonly onChange: (record: SpawnRecord) => void;
	private readonly live = new Map<string, LiveSpawn>();
	private readonly history: SpawnRecord[] = [];
	private disposed = false;

	constructor(options: SessionSpawnerOptions) {
		this.baseUrl = options.baseUrl;
		this.rootDir = options.rootDir ?? process.cwd();
		this.bin = options.bin?.trim() || defaultPiBin();
		this.defaultCwd = options.cwd ?? process.cwd();
		this.sessionDir = options.sessionDir?.trim() || process.env[ENV.sessionDir]?.trim() || undefined;
		this.logDir = options.logDir ?? path.join(getCacheRoot(), "spawns");
		this.extraEnv = options.env ?? {};
		this.onChange = options.onChange ?? (() => {});
		this.available = !["0", "false", "off"].includes(
			(process.env[ENV.spawn] ?? "").trim().toLowerCase(),
		);
	}

	get enabled(): boolean {
		return this.available && !this.disposed && isLoopbackUrl(this.baseUrl);
	}

	get defaultWorkingDir(): string {
		return this.defaultCwd;
	}

	get piBin(): string {
		return this.bin;
	}

	list(): SpawnRecord[] {
		const liveIds = new Set(Array.from(this.live.values(), (entry) => entry.record.spawnId));
		const recent = this.history
			.filter((record) => !liveIds.has(record.spawnId))
			.slice(-MAX_RECORDS);
		return [...recent, ...Array.from(this.live.values(), (entry) => entry.record)].map((record) => ({
			...record,
		}));
	}

	get(spawnId: string): SpawnRecord | null {
		const entry = this.live.get(spawnId);
		if (entry) return { ...entry.record };
		const record = this.history.find((item) => item.spawnId === spawnId);
		return record ? { ...record } : null;
	}

	logTail(spawnId: string, maxBytes = LOG_TAIL_BYTES): string | null {
		const entry = this.live.get(spawnId);
		if (entry) return entry.tail.slice(-maxBytes);
		const record = this.history.find((item) => item.spawnId === spawnId);
		if (!record?.logFile) return null;
		try {
			return readFileSync(record.logFile, "utf8").slice(-maxBytes);
		} catch {
			return null;
		}
	}

	async spawn(request: SpawnRequest): Promise<SpawnRecord> {
		if (!this.enabled) {
			throw new SpawnError(
				403,
				isLoopbackUrl(this.baseUrl)
					? "spawning is disabled (set PI_WEBAPP_SPAWN=1 to enable)"
					: "spawning requires the dashboard to be bound to a loopback address",
			);
		}
		await this.assertExecutable(this.bin);

		mkdirSync(this.logDir, { recursive: true });
		const spawnId = `spawn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const logFile = path.join(this.logDir, `${spawnId}.log`);
		const args = ["--mode", "rpc"];
		if (this.sessionDir) args.push("--session-dir", this.sessionDir);
		if (request.sessionFile) args.push("--session", request.sessionFile);
		if (request.model) args.push("--model", request.model);
		if (request.extraArgs?.length) args.push(...request.extraArgs);

		const baseUrl = (() => {
			try {
				return new URL(this.baseUrl);
			} catch {
				throw new SpawnError(500, `invalid dashboard base URL: ${this.baseUrl}`);
			}
		})();
		const port = baseUrl.port || (baseUrl.protocol === "https:" ? "443" : "80");
		const host = baseUrl.hostname;
		const env: Record<string, string> = { ...process.env } as Record<string, string>;
		for (const key of [
			ENV.parentSessionId,
			ENV.agentName,
			ENV.legacyParentSessionId,
			ENV.legacyAgentName,
		]) {
			delete env[key];
		}
		env[ENV.host] = host;
		env[ENV.port] = port;
		env[ENV.spawnId] = spawnId;
		Object.assign(env, this.extraEnv);

		const record: SpawnRecord = {
			spawnId,
			cwd: request.cwd,
			status: "starting",
			startedAt: Date.now(),
			prompt: request.prompt,
			model: request.model,
			agentName: request.agentName,
			sessionFile: request.sessionFile,
			logFile,
		};

		let log: WriteStream | null = null;
		try {
			log = createWriteStream(logFile, { flags: "a" });
			log.on("error", () => {
				log = null;
			});
		} catch {
			log = null;
		}

		let child: ChildProcess;
		try {
			child = spawn(this.bin, args, {
				cwd: request.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				detached: false,
			});
		} catch (error) {
			record.status = "failed";
			record.error = `could not start pi: ${error instanceof Error ? error.message : String(error)}`;
			record.endedAt = Date.now();
			this.pushHistory(record);
			this.onChange(record);
			throw new SpawnError(500, record.error);
		}

		record.pid = child.pid ?? undefined;
		const entry: LiveSpawn = { record, child, log, killTimer: null, tail: "", stopping: false };
		this.live.set(spawnId, entry);
		this.onChange({ ...record });

		child.on("error", (error) => {
			record.status = "failed";
			record.error = `pi failed to start: ${error.message}`;
			this.finalize(spawnId);
		});
		child.on("exit", (code, signal) => {
			record.exitCode = code ?? undefined;
			record.endedAt = Date.now();
			record.status = entry.stopping
				? "exited"
				: record.status === "failed"
					? "failed"
					: code === 0
						? "exited"
						: "failed";
			if (!record.error && signal && !entry.stopping) record.error = `terminated by ${signal}`;
			this.finalize(spawnId);
		});
		child.on("spawn", () => {
			record.status = "running";
			this.onChange({ ...record });
		});

		const capture = (chunk: Buffer): void => {
			const text = chunk.toString("utf8");
			entry.tail = `${entry.tail}${text}`.slice(-LOG_TAIL_BYTES);
			entry.log?.write(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer) => capture(chunk));
		child.stderr?.on("data", (chunk: Buffer) => capture(chunk));
		child.stdout?.resume();
		child.stderr?.resume();
		// Keep stdin open: rpc mode stays alive until the stream closes.
		child.stdin?.on("error", () => {});

		return { ...record };
	}

	attachSession(spawnId: string, sessionId: string): void {
		const entry = this.live.get(spawnId);
		if (!entry) {
			const record = this.history.find((item) => item.spawnId === spawnId);
			if (record) {
				record.sessionId = sessionId;
				this.onChange({ ...record });
			}
			return;
		}
		if (entry.record.sessionId === sessionId) return;
		entry.record.sessionId = sessionId;
		this.onChange({ ...entry.record });
	}

	stop(spawnId: string): boolean {
		const entry = this.live.get(spawnId);
		if (!entry) return false;
		const { child, record } = entry;
		if (child.exitCode !== null || child.signalCode !== null) return false;
		entry.stopping = true;
		record.status = "exited";
		record.endedAt = record.endedAt ?? Date.now();
		try {
			child.kill("SIGTERM");
		} catch {
			return false;
		}
		if (!entry.killTimer) {
			entry.killTimer = setTimeout(() => {
				entry.killTimer = null;
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}, KILL_GRACE_MS);
			entry.killTimer.unref?.();
		}
		return true;
	}

	stopAll(): void {
		this.disposed = true;
		for (const spawnId of Array.from(this.live.keys())) {
			const entry = this.live.get(spawnId);
			if (!entry) continue;
			if (entry.killTimer) clearTimeout(entry.killTimer);
			entry.stopping = true;
			try {
				entry.child.kill("SIGKILL");
			} catch {
				// ignore
			}
			try {
				entry.child.stdin?.destroy();
			} catch {
				// ignore
			}
		}
		this.live.clear();
	}

	private finalize(spawnId: string): void {
		const entry = this.live.get(spawnId);
		if (!entry) return;
		if (entry.killTimer) clearTimeout(entry.killTimer);
		try {
			entry.log?.end();
		} catch {
			// ignore
		}
		this.live.delete(spawnId);
		this.pushHistory(entry.record);
		this.onChange({ ...entry.record });
	}

	private pushHistory(record: SpawnRecord): void {
		this.history.push({ ...record });
		while (this.history.length > MAX_RECORDS * 2) this.history.shift();
	}

	private async assertExecutable(bin: string): Promise<void> {
		if (!bin.includes(path.sep)) return; // rely on PATH resolution
		try {
			await access(bin, fsConstants.X_OK);
		} catch {
			throw new SpawnError(
				500,
				`pi executable not found at ${bin}; set ${ENV.piBin} to the pi binary`,
			);
		}
	}
}
