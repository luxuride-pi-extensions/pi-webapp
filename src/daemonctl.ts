/**
 * Control helpers for the standalone dashboard daemon.
 *
 * The `/webapp daemon` command uses these so a dashboard can be kept running
 * without any knowledge of the package layout, the node binary, or a PATH
 * entry: this process already knows all three.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_HOST, DEFAULT_PORT, ENV } from "./protocol.js";
import { getCacheRoot } from "./storage.js";

export interface DaemonPidInfo {
	pid: number;
	url: string;
	host: string;
	port: number;
	startedAt: number;
}

export interface DaemonStatus {
	running: boolean;
	healthy: boolean;
	url: string;
	pid?: number;
	startedAt?: number;
	managed: boolean;
	detail?: string;
}

export interface StartDaemonResult {
	started: boolean;
	alreadyRunning: boolean;
	url: string;
	pid?: number;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function daemonPidFile(cacheRoot: string = getCacheRoot()): string {
	return path.join(cacheRoot, "daemon.pid");
}

export function readDaemonPidInfo(cacheRoot: string = getCacheRoot()): DaemonPidInfo | null {
	const file = daemonPidFile(cacheRoot);
	try {
		const raw = readFileSync(file, "utf8").trim();
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<DaemonPidInfo>;
		if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
			return null;
		}
		return {
			pid: parsed.pid,
			url: typeof parsed.url === "string" ? parsed.url : "",
			host: typeof parsed.host === "string" ? parsed.host : DEFAULT_HOST,
			port: typeof parsed.port === "number" ? parsed.port : DEFAULT_PORT,
			startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
		};
	} catch {
		return null;
	}
}

export function writeDaemonPidInfo(info: DaemonPidInfo, cacheRoot: string = getCacheRoot()): void {
	try {
		writeFileSync(daemonPidFile(cacheRoot), `${JSON.stringify(info)}\n`, "utf8");
	} catch {
		// A read-only cache directory must not stop the daemon from serving.
	}
}

export function removeDaemonPidFile(cacheRoot: string = getCacheRoot()): void {
	try {
		rmSync(daemonPidFile(cacheRoot), { force: true });
	} catch {
		// ignore
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function envPort(): number {
	const value = Number(process.env[ENV.port]);
	return Number.isInteger(value) && value >= 0 ? value : DEFAULT_PORT;
}

export function defaultDaemonHost(): string {
	return process.env[ENV.host]?.trim() || DEFAULT_HOST;
}

export function defaultDaemonPort(): number {
	return envPort();
}

export function dashboardUrl(host = defaultDaemonHost(), port = defaultDaemonPort()): string {
	const displayHost = host === "0.0.0.0" || host === "::" ? DEFAULT_HOST : host;
	return `http://${displayHost}:${port}`;
}

export async function probeHealth(url: string, timeoutMs = 1200): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${url}/api/health`, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export function daemonBin(): string {
	const candidates = [path.join(PACKAGE_ROOT, "bin", "pi-webapp.mjs")];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(`pi-webapp: daemon entry point missing (looked for ${candidates.join(", ")})`);
	}
	return found;
}

/**
 * Start the daemon as a detached child of this process, then wait until it
 * answers `/api/health`. Idempotent: an already healthy dashboard is reused.
 */
export async function startDetachedDaemon(options: {
	host?: string;
	port?: number;
	cwd?: string;
	waitMs?: number;
} = {}): Promise<StartDaemonResult> {
	const host = options.host ?? defaultDaemonHost();
	const port = options.port ?? defaultDaemonPort();
	const url = dashboardUrl(host, port);

	const existing = readDaemonPidInfo();
	if (existing && !isProcessAlive(existing.pid)) removeDaemonPidFile();
	if (await probeHealth(url)) {
		return { started: false, alreadyRunning: true, url, pid: existing?.pid };
	}

	const child = spawn(
		process.execPath,
		[daemonBin(), "serve", "--host", host, "--port", String(port)],
		{
			cwd: options.cwd ?? process.cwd(),
			detached: true,
			stdio: "ignore",
			env: { ...process.env, PI_WEBAPP_HOST: host, PI_WEBAPP_PORT: String(port) },
		},
	);
	child.unref();

	const deadline = Date.now() + (options.waitMs ?? 10_000);
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (await probeHealth(url, 800)) {
			const info = readDaemonPidInfo();
			return { started: true, alreadyRunning: false, url, pid: info?.pid ?? child.pid };
		}
		if (child.exitCode !== null) {
			throw new Error(
				`pi-webapp: the daemon exited immediately (code ${child.exitCode}). Is port ${port} already used by something else?`,
			);
		}
	}

	throw new Error(`pi-webapp: the daemon did not become healthy at ${url} within the timeout.`);
}

/** Stop a daemon started by `/webapp daemon start` (or any daemon that wrote a pid file). */
export async function stopDetachedDaemon(): Promise<{ stopped: boolean; pid?: number; detail?: string }> {
	const info = readDaemonPidInfo();
	if (!info) {
		return { stopped: false, detail: "no daemon pid file — nothing started by pi-webapp is running" };
	}
	if (!isProcessAlive(info.pid)) {
		removeDaemonPidFile();
		return { stopped: false, pid: info.pid, detail: "the recorded daemon process is no longer running" };
	}

	try {
		process.kill(info.pid, "SIGTERM");
	} catch (error) {
		return { stopped: false, pid: info.pid, detail: (error as Error).message };
	}

	const deadline = Date.now() + 6_000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (!isProcessAlive(info.pid)) {
			removeDaemonPidFile();
			return { stopped: true, pid: info.pid };
		}
	}

	try {
		process.kill(info.pid, "SIGKILL");
	} catch {
		// The process may have exited between the check and the signal.
	}
	removeDaemonPidFile();
	return { stopped: true, pid: info.pid, detail: "forced after a 6s graceful shutdown timeout" };
}

export async function daemonStatus(host = defaultDaemonHost(), port = defaultDaemonPort()): Promise<DaemonStatus> {
	const info = readDaemonPidInfo();
	const alive = info ? isProcessAlive(info.pid) : false;
	const url = info?.url || dashboardUrl(host, port);
	const healthy = await probeHealth(url);
	return {
		running: healthy,
		healthy,
		url,
		pid: alive ? info?.pid : undefined,
		startedAt: info?.startedAt,
		managed: alive,
		detail: info && !alive ? "stale pid file removed" : undefined,
	};
}
