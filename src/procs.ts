/**
 * Process-level session ownership detection (Linux `/proc`).
 *
 * The dashboard can tail session files directly ("leeching"), which tells it
 * what happened but not whether the writer is still alive. That distinction
 * matters twice:
 *
 *  - a session that is neither recent nor owned by a live `pi` process is dead
 *    and does not deserve a sidebar entry at all;
 *  - taking a session over is only safe when nobody is working on it, and only
 *    possible (without data loss) when the owning process can be stopped.
 *
 * `pi` exports `PI_SESSION_ID` into its own environment, so a process whose
 * environment carries the id and whose executable is `pi` is the owner of that
 * session. Everything here is best effort: any failure yields "unknown", never
 * an exception, and non-Linux platforms simply report no owners.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

/** Defensive caps so a hostile or huge `/proc` cannot stall a leech scan. */
const MAX_PIDS = 8192;
const MAX_ENVIRON_BYTES = 256 * 1024;
const MAX_CMDLINE_BYTES = 8 * 1024;

const PI_COMMAND = /^pi(\.(js|mjs|cjs))?$/i;
const SESSION_ID_ENV = "PI_SESSION_ID=";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PiSessionOwners {
	/** Session id -> pids of the `pi` processes that own it. */
	pids: Map<string, number[]>;
	/** Pids that looked like pi but whose environment could not be read. */
	unreadable: number;
}

function readText(filePath: string, limit: number): string | null {
	try {
		const buffer = readFileSync(filePath);
		if (buffer.byteLength > limit) return null;
		return buffer.toString("utf8");
	} catch {
		return null;
	}
}

/**
 * Session files are named `<timestamp>_<sessionId>.jsonl`, which lets a scan
 * decide ownership for stale files without reading their header first.
 */
export function sessionIdFromSessionFile(filePath: string): string | null {
	const name = basename(filePath);
	if (!name.endsWith(".jsonl")) return null;
	const stem = name.slice(0, -".jsonl".length);
	const separator = stem.lastIndexOf("_");
	if (separator < 0) return null;
	const candidate = stem.slice(separator + 1);
	return UUID.test(candidate) ? candidate : null;
}

/** True when `pid` exists (a process we may not signal still counts). */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Sends a signal, returning whether the target accepted it. */
export function killPid(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

function isPiCommand(pid: number): boolean {
	const cmdline = readText(`/proc/${pid}/cmdline`, MAX_CMDLINE_BYTES);
	if (cmdline === null) return false;
	const argv0 = cmdline.split("\0")[0] ?? "";
	if (!argv0) return false;
	const name = basename(argv0);
	if (PI_COMMAND.test(name)) return true;
	// `node /path/to/pi` or a wrapper script that re-execs by absolute path.
	const joined = cmdline.split("\0").join(" ");
	return /(^|\/)pi(-coding-agent)?(\s|$)/.test(joined) && !/\bnode\b.*\b(pi-lens|pi-web|pi-subagents)\b/.test(joined);
}

function sessionIdFromEnviron(pid: number): string | null {
	const environ = readText(`/proc/${pid}/environ`, MAX_ENVIRON_BYTES);
	if (environ === null) return null;
	for (const entry of environ.split("\0")) {
		if (!entry.startsWith(SESSION_ID_ENV)) continue;
		const value = entry.slice(SESSION_ID_ENV.length).trim();
		return value || null;
	}
	return null;
}

/**
 * Scans `/proc` once and returns every live `pi` process grouped by the session
 * it owns. Cost is one environ read per process, so callers should reuse the
 * result for a whole scan cycle rather than calling it per session.
 */
export function scanPiSessionOwners(): PiSessionOwners {
	const pids = new Map<string, number[]>();
	const result: PiSessionOwners = { pids, unreadable: 0 };
	if (process.platform !== "linux") return result;

	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return result;
	}

	let seen = 0;
	for (const entry of entries) {
		if (seen >= MAX_PIDS) break;
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		seen += 1;

		let owner: string | null;
		try {
			owner = sessionIdFromEnviron(pid);
		} catch {
			result.unreadable += 1;
			continue;
		}
		if (!owner) continue;
		if (!isPiCommand(pid)) continue;

		const existing = pids.get(owner) ?? [];
		existing.push(pid);
		pids.set(owner, existing);
	}

	for (const list of pids.values()) list.sort((a, b) => a - b);
	return result;
}

/** A live `pi` process, as far as `/proc` can tell. */
export interface PiProcess {
	pid: number;
	/** Working directory of the process (`/proc/<pid>/cwd`). */
	cwd: string;
	/** Wall-clock start time in milliseconds. */
	startedAt: number;
}

/** `/proc/<pid>/stat` reports starttime in clock ticks; Linux uses 100 Hz. */
const CLOCK_TICK_MS = 10;
const PROCESS_CACHE_MS = 2_000;

let processCache: { at: number; processes: PiProcess[] } | null = null;

function bootTimeMs(): number | null {
	const stat = readText("/proc/stat", 64 * 1024);
	if (!stat) return null;
	for (const line of stat.split("\n")) {
		if (!line.startsWith("btime ")) continue;
		const seconds = Number(line.slice("btime ".length).trim());
		return Number.isFinite(seconds) ? seconds * 1000 : null;
	}
	return null;
}

function startTimeMs(pid: number): number | null {
	const stat = readText(`/proc/${pid}/stat`, 8 * 1024);
	if (!stat) return null;
	// The command name is parenthesised and may contain spaces, so split after it.
	const end = stat.lastIndexOf(")");
	if (end < 0) return null;
	const fields = stat.slice(end + 1).trim().split(/\s+/);
	// Fields after `comm` start at index 3 (state); starttime is field 22.
	const ticks = Number(fields[19]);
	return Number.isFinite(ticks) ? ticks * CLOCK_TICK_MS : null;
}

function workingDirectory(pid: number): string | null {
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		return null;
	}
}

/**
 * Lists live `pi` processes with their working directory and start time.
 *
 * `pi` does not export its session id into its own environment, so a process
 * started outside this extension can only be matched to a transcript
 * heuristically: same working directory, started when the session started.
 * Cached briefly because callers ask once per session on every state request.
 */
export function scanPiProcesses(): PiProcess[] {
	if (process.platform !== "linux") return [];
	const now = Date.now();
	if (processCache && now - processCache.at < PROCESS_CACHE_MS) return processCache.processes;

	const processes: PiProcess[] = [];
	const boot = bootTimeMs();
	let entries: string[] = [];
	try {
		entries = readdirSync("/proc");
	} catch {
		entries = [];
	}

	if (boot !== null) {
		let seen = 0;
		for (const entry of entries) {
			if (seen >= MAX_PIDS) break;
			if (!/^\d+$/.test(entry)) continue;
			const pid = Number(entry);
			if (pid === process.pid) continue;
			seen += 1;
			if (!isPiCommand(pid)) continue;
			const cwd = workingDirectory(pid);
			const started = startTimeMs(pid);
			if (!cwd || started === null) continue;
			processes.push({ pid, cwd, startedAt: boot + started });
		}
	}

	processCache = { at: now, processes };
	return processes;
}

/** Test seam: forget the cached process list. */
export function resetPiProcessCache(): void {
	processCache = null;
}
