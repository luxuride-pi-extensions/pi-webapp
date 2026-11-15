/**
 * Standalone dashboard daemon.
 *
 * `pi-webapp serve` runs the same HTTP/WebSocket server the extension uses,
 * but without any pi process behind it: sessions are discovered by leeching
 * pi session files, pi instances join when they load the extension, and the
 * dashboard can start new pi sessions itself.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { DEFAULT_HOST, DEFAULT_PORT, ENV, type SpawnRequest } from "./protocol.js";
import { WebappServer } from "./server.js";
import { SessionSpawner, isLoopbackUrl } from "./spawn.js";

export interface DaemonOptions {
	host?: string;
	port?: number;
	/** Enable leeching of session files (default: true). */
	leech?: boolean;
	/** Extra directories to leech. */
	leechDirs?: string[];
	/** Allow the dashboard to start pi sessions (default: true on loopback). */
	spawn?: boolean;
	/** Working directory used when a spawn request omits one. */
	cwd?: string;
	/** `--session-dir` passed to spawned sessions. */
	sessionDir?: string;
	/** `pi` executable used for spawned sessions. */
	bin?: string;
}

export interface DaemonHandle {
	url: string;
	spawner: SessionSpawner | null;
	stop(): Promise<void>;
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
	const host = options.host?.trim() || process.env[ENV.host]?.trim() || DEFAULT_HOST;
	const envPort = Number(process.env[ENV.port]);
	const port =
		options.port ?? (Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_PORT);
	const leechDirs = options.leechDirs?.length ? options.leechDirs : undefined;
	const server = new WebappServer({
		host,
		port,
		...(options.leech === false ? { leech: false as const } : { leech: leechDirs ? { dirs: leechDirs } : {} }),
	});

	await server.start();
	// Warm the snapshot so the first page load (and /api/leech) already has data.
	await server.rescanLeech().catch(() => undefined);

	const spawnEnabled = options.spawn !== false;
	let spawner: SessionSpawner | null = null;
	if (spawnEnabled) {
		const loopback = isLoopbackUrl(server.url);
		if (!loopback) {
			process.stderr.write(
				`pi-webapp: spawning disabled because the dashboard is not bound to a loopback address (${server.url})\n`,
			);
		}
		spawner = new SessionSpawner({
			baseUrl: server.url,
			cwd: options.cwd ?? process.cwd(),
			sessionDir: options.sessionDir,
			bin: options.bin,
			onChange: (record) => server.notifySpawnChange(record),
		});
		server.setSessionSpawner(spawner);
	}

	server.setLocalPromptHandler(null);
	return {
		url: server.url,
		spawner,
		async stop(): Promise<void> {
			try {
				spawner?.stopAll();
			} catch {
				// ignore
			}
			await server.stop();
		},
	};
}

export interface CliOptions extends DaemonOptions {
	help: boolean;
	version: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
	const options: CliOptions = { help: false, version: false };
	const rest: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const takeValue = (): string => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`missing value for ${arg}`);
			}
			index += 1;
			return next;
		};
		switch (arg) {
			case "serve":
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			case "-v":
			case "--version":
				options.version = true;
				break;
			case "--host":
				options.host = takeValue();
				break;
			case "-p":
			case "--port":
				options.port = Number(takeValue());
				break;
			case "--cwd":
				options.cwd = path.resolve(takeValue());
				break;
			case "--session-dir":
				options.sessionDir = path.resolve(takeValue());
				break;
			case "--pi":
				options.bin = takeValue();
				break;
			case "--leech-dir":
				options.leechDirs = [...(options.leechDirs ?? []), path.resolve(takeValue())];
				break;
			case "--no-leech":
				options.leech = false;
				break;
			case "--no-spawn":
				options.spawn = false;
				break;
			default:
				if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
				rest.push(arg);
		}
	}
	if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
	if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
		throw new Error("--port must be an integer between 0 and 65535");
	}
	return options;
}

export const HELP_TEXT = `pi-webapp — browser dashboard for pi coding-agent sessions

Usage:
  pi-webapp [serve] [options]

Options:
  -p, --port <port>          Port to listen on (default: $PI_WEBAPP_PORT or ${DEFAULT_PORT})
      --host <host>          Bind address (default: $PI_WEBAPP_HOST or ${DEFAULT_HOST})
      --cwd <dir>            Default working directory for sessions started from the UI
      --session-dir <dir>    --session-dir passed to sessions started from the UI
      --pi <path>            pi executable for started sessions (default: $PI_WEBAPP_PI_BIN or pi)
      --leech-dir <dir>      Extra directory to leech (repeatable)
      --no-leech             Do not leech pi session files
      --no-spawn             Do not allow the dashboard to start pi sessions
  -v, --version              Print the version and exit
  -h, --help                 Show this help

Environment:
  PI_WEBAPP_PORT, PI_WEBAPP_HOST, PI_WEBAPP_CACHE_DIR, PI_WEBAPP_LEECH,
  PI_WEBAPP_LEECH_DIR, PI_WEBAPP_SPAWN, PI_WEBAPP_PI_BIN, PI_WEBAPP_SESSION_DIR,
  PI_WEBAPP_PLAYWRIGHT

Security: the daemon binds to ${DEFAULT_HOST} by default and has no login screen.
Put it behind Caddy/Nginx/Tailscale if you need remote access. Starting pi
sessions from the dashboard is only allowed on a loopback bind (disable with
PI_WEBAPP_SPAWN=0 or --no-spawn).
`;

export interface RunResult {
	code: number;
}

/** Runs the CLI; separated from the bin shim so tests can drive it. */
export async function runCli(
	argv: readonly string[],
	io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
	},
): Promise<RunResult> {
	let options: CliOptions;
	try {
		options = parseArgs(argv);
	} catch (error) {
		io.stderr(`pi-webapp: ${error instanceof Error ? error.message : String(error)}\n`);
		io.stderr(HELP_TEXT);
		return { code: 2 };
	}
	if (options.help) {
		io.stdout(HELP_TEXT);
		return { code: 0 };
	}
	if (options.version) {
		io.stdout(`${readVersion()}\n`);
		return { code: 0 };
	}

	let handle: DaemonHandle;
	try {
		handle = await startDaemon(options);
	} catch (error) {
		io.stderr(`pi-webapp: failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
		return { code: 1 };
	}

	io.stdout(`pi-webapp listening on ${handle.url}\n`);
	io.stdout(
		handle.spawner
			? `sessions can be started from the dashboard (${handle.spawner.piBin})\n`
			: "sessions cannot be started from the dashboard\n",
	);

	let stopping = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		io.stdout(`pi-webapp: shutting down (${signal})\n`);
		try {
			await handle.stop();
		} catch {
			// best effort
		}
		process.exit(0);
	};

	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) {
		process.once(signal, () => void shutdown(signal));
	}
	await new Promise<void>(() => {
		// Serve until a signal arrives.
	});
	return { code: 0 };
}

function readVersion(): string {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require("../package.json") as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** Convenience type guard used by tests. */
export function isSpawnRequest(value: unknown): value is SpawnRequest {
	return typeof value === "object" && value !== null && typeof (value as SpawnRequest).cwd === "string";
}
