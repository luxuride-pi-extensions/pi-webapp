/**
 * systemd **user** service management for the pi-webapp dashboard.
 *
 * The goal is that `pi install …` (or a plain `npm install`) is the only step a
 * user needs: the dashboard then starts at login, survives every pi exit, and
 * pi sessions simply join it instead of each trying to bind the port.
 *
 * Two entry points drive this:
 *  - `scripts/postinstall.mjs` (runs when npm is allowed to execute lifecycle
 *    scripts) calls {@link installSystemdService} once after installation.
 *  - the extension calls {@link ensureAutostartService} on `session_start`, so
 *    installations that skipped lifecycle scripts (npm 12 blocks them by
 *    default, and `pi install` uses `--omit=dev`) converge to the same state.
 *
 * Everything here is best-effort and idempotent: a missing systemd session, a
 * read-only config dir, or a port that is still held by another process must
 * never break a pi session.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_HOST, DEFAULT_PORT, ENV } from "./protocol.js";
import { defaultPiBin } from "./spawn.js";
import { getCacheRoot } from "./storage.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_UNIT_NAME = "pi-webapp.service";
const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/;

export interface SystemdServiceStatus {
	/** True when a systemd user session is reachable from this process. */
	available: boolean;
	unitName: string;
	unitPath: string;
	installed: boolean;
	enabled: boolean;
	active: boolean;
	detail?: string;
}

export interface AutostartState {
	installedAt?: number;
	unitPath?: string;
	disabledAt?: number;
	disabledReason?: string;
}

export interface AutostartResult {
	/** The unit file exists after this call. */
	installed: boolean;
	/** This call wrote or rewrote the unit file. */
	changed: boolean;
	/** The service is active (or became active) and answering on the dashboard URL. */
	started: boolean;
	url?: string;
	unitPath?: string;
	/** Why nothing was done, when nothing was done. */
	skipped?: string;
	detail?: string;
}

interface SystemctlResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function systemdUnitName(): string {
	const override = process.env[ENV.systemdUnit]?.trim();
	if (override) {
		if (!UNIT_NAME_PATTERN.test(override)) {
			throw new Error(`${ENV.systemdUnit} must look like "name.service" (got: ${override})`);
		}
		return override;
	}
	return DEFAULT_UNIT_NAME;
}

function configBase(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	if (xdg && path.isAbsolute(xdg)) return xdg;
	return path.join(os.homedir(), ".config");
}

export function systemdUnitDir(): string {
	return path.join(configBase(), "systemd", "user");
}

export function systemdUnitPath(unitName: string = systemdUnitName()): string {
	return path.join(systemdUnitDir(), unitName);
}

let availabilityProbe: boolean | undefined;

/** Cached probe: is `systemctl --user` usable here? */
export function systemdAvailable(): boolean {
	if (availabilityProbe !== undefined) return availabilityProbe;
	if (process.platform !== "linux") {
		availabilityProbe = false;
		return false;
	}
	const probe = systemctl(["show-environment"]);
	availabilityProbe = probe.code === 0;
	return availabilityProbe;
}

/** Test seam so unit tests do not need a live systemd session. */
export function resetSystemdProbe(): void {
	availabilityProbe = undefined;
}

function systemctl(args: string[]): SystemctlResult {
	try {
		const result = spawnSync("systemctl", ["--user", ...args], {
			encoding: "utf8",
			timeout: 15_000,
		});
		return {
			code: result.status ?? 1,
			stdout: (result.stdout ?? "").trim(),
			stderr: (result.stderr ?? "").trim(),
		};
	} catch (error) {
		return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function quoteArg(value: string): string {
	if (/^[A-Za-z0-9_@+=:,./-]+$/.test(value)) return value;
	return `"${value.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function environmentLine(key: string, value: string): string {
	const escaped = value.replace(/%/g, "%%").replace(/"/g, '\\"');
	const pair = `${key}=${escaped}`;
	return `Environment=${/[\s"']/.test(value) ? `"${pair}"` : pair}`;
}

/** The exact unit file content this package wants for `host`/`port`. */
export function buildSystemdUnit(options: { host?: string; port?: number; workingDir?: string } = {}): string {
	const host = options.host?.trim() || process.env[ENV.host]?.trim() || DEFAULT_HOST;
	const envPort = Number(process.env[ENV.port]);
	const port =
		options.port ?? (Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_PORT);
	const workingDir = options.workingDir?.trim() || os.homedir();
	const pathEnv = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	const piBin = defaultPiBin();

	return [
		"[Unit]",
		"Description=pi-webapp dashboard for pi coding-agent sessions",
		"Documentation=https://github.com/luxuride-pi-extensions/pi-webapp",
		"After=default.target",
		// Keep retrying forever: the service intentionally waits for a busy port.
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		`WorkingDirectory=${quoteArg(workingDir)}`,
		environmentLine("PATH", pathEnv),
		environmentLine(ENV.host, host),
		environmentLine(ENV.port, String(port)),
		environmentLine(ENV.piBin, piBin),
		`ExecStart=${quoteArg(process.execPath)} ${quoteArg(daemonBin())} serve --wait --host ${quoteArg(host)} --port ${String(port)}`,
		// `--wait` already retries the bind; restart covers crashes.
		"Restart=on-failure",
		"RestartSec=3",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

export function daemonBin(): string {
	return path.join(PACKAGE_ROOT, "bin", "pi-webapp.mjs");
}

export function systemdServiceStatus(): SystemdServiceStatus {
	const unitName = systemdUnitName();
	const unitPath = systemdUnitPath(unitName);
	const available = systemdAvailable();
	const installed = existsSync(unitPath);
	if (!available) {
		return {
			available,
			unitName,
			unitPath,
			installed,
			enabled: false,
			active: false,
			detail: "no systemd user session (or not Linux)",
		};
	}
	const enabledState = systemctl(["is-enabled", unitName]);
	const activeState = systemctl(["is-active", unitName]);
	return {
		available,
		unitName,
		unitPath,
		installed,
		enabled: enabledState.code === 0 && enabledState.stdout === "enabled",
		active: activeState.code === 0 && activeState.stdout === "active",
		detail: [enabledState.stdout && `enabled: ${enabledState.stdout}`, activeState.stdout && `active: ${activeState.stdout}`]
			.filter(Boolean)
			.join(", "),
	};
}

function autostartStateFile(): string {
	return path.join(getCacheRoot(), "autostart.json");
}

export function readAutostartState(): AutostartState {
	try {
		const raw = readFileSync(autostartStateFile(), "utf8").trim();
		if (!raw) return {};
		const parsed = JSON.parse(raw) as AutostartState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeAutostartState(state: AutostartState): void {
	try {
		mkdirSync(getCacheRoot(), { recursive: true });
		writeFileSync(autostartStateFile(), `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	} catch {
		// The marker is an optimisation; never fail because of it.
	}
}

/** Remembers that the user uninstalled the unit, so pi stops re-adding it. */
export function markAutostartDisabled(reason: string): void {
	writeAutostartState({ ...readAutostartState(), disabledAt: Date.now(), disabledReason: reason });
}

export function clearAutostartDisabled(): void {
	const state = readAutostartState();
	if (state.disabledAt === undefined) return;
	delete state.disabledAt;
	delete state.disabledReason;
	writeAutostartState(state);
}

function autostartPermittedByEnv(): boolean {
	const raw = (process.env[ENV.autostart] ?? "").trim().toLowerCase();
	return !["0", "false", "off", "no"].includes(raw);
}

/** Writes the unit file, reloads systemd, enables it, and optionally starts it. */
export async function installSystemdService(
	options: { host?: string; port?: number; start?: boolean; waitMs?: number } = {},
): Promise<AutostartResult> {
	const unitName = systemdUnitName();
	const unitPath = systemdUnitPath(unitName);
	const host = options.host?.trim() || process.env[ENV.host]?.trim() || DEFAULT_HOST;
	const port = options.port ?? (Number(process.env[ENV.port]) || DEFAULT_PORT);

	if (process.platform !== "linux") {
		throw new Error("the systemd autostart integration is Linux-only; see the README for launchd and Task Scheduler examples");
	}
	if (!systemdAvailable()) {
		throw new Error("systemd user session not available (is `systemctl --user` working?)");
	}

	const desired = buildSystemdUnit({ host, port });
	const previous = existsSync(unitPath) ? readFileSync(unitPath, "utf8") : null;
	const changed = previous !== desired;
	if (changed) {
		mkdirSync(path.dirname(unitPath), { recursive: true });
		writeFileSync(unitPath, desired, "utf8");
		systemctl(["daemon-reload"]);
	}

	const before = systemdServiceStatus();
	let restarted = false;
	if (!before.enabled) {
		const enabled = systemctl(["enable", unitName]);
		if (enabled.code !== 0) {
			throw new Error(`systemctl --user enable ${unitName} failed: ${enabled.stderr || enabled.stdout || `exit ${enabled.code}`}`);
		}
	}
	if (options.start !== false) {
		const start = systemctl(["start", unitName]);
		if (start.code !== 0) {
			throw new Error(`systemctl --user start ${unitName} failed: ${start.stderr || start.stdout || `exit ${start.code}`}`);
		}
		// `Type=simple` returns before the socket is bound; wait for the dashboard.
		const healthy = await waitForHealth(dashboardUrlFor(host, port), options.waitMs ?? 8_000);
		if (!healthy) {
			// The unit is running but waiting for a busy port (`--wait`): a pi
			// process already serves the dashboard, which is fine.
			return {
				installed: true,
				changed,
				started: false,
				url: dashboardUrlFor(host, port),
				unitPath,
				detail: "service is enabled but the port is still held by another dashboard",
			};
		}
		restarted = changed && previous !== null;
	}

	// A successful install clears an earlier opt-out.
	writeAutostartState({ installedAt: Date.now(), unitPath });
	return {
		installed: true,
		changed,
		started: options.start !== false,
		url: dashboardUrlFor(host, port),
		unitPath,
		detail: restarted ? "unit file changed; service restarted" : undefined,
	};
}

/** Starts the service if the unit exists and is enabled (no install side effects). */
export async function startSystemdService(
	options: { host?: string; port?: number; waitMs?: number } = {},
): Promise<AutostartResult> {
	const status = systemdServiceStatus();
	if (!status.installed) {
		return { installed: false, changed: false, started: false, skipped: `no unit at ${status.unitPath}`, unitPath: status.unitPath };
	}
	if (!status.available) {
		return { installed: true, changed: false, started: false, skipped: status.detail ?? "systemd unavailable", unitPath: status.unitPath };
	}
	const start = systemctl(["start", status.unitName]);
	const host = options.host?.trim() || process.env[ENV.host]?.trim() || DEFAULT_HOST;
	const port = options.port ?? (Number(process.env[ENV.port]) || DEFAULT_PORT);
	const healthy = start.code === 0 && (await waitForHealth(dashboardUrlFor(host, port), options.waitMs ?? 8_000));
	return {
		installed: true,
		changed: false,
		started: healthy,
		url: dashboardUrlFor(host, port),
		unitPath: status.unitPath,
		detail: start.code === 0 ? undefined : start.stderr || start.stdout,
	};
}

export async function stopSystemdService(): Promise<SystemdServiceStatus> {
	const status = systemdServiceStatus();
	if (!status.installed || !status.available) return status;
	systemctl(["stop", status.unitName]);
	return systemdServiceStatus();
}

export interface UninstallResult {
	removed: boolean;
	unitPath: string;
	stopped: boolean;
}

export function uninstallSystemdService(options: { start?: boolean } = {}): UninstallResult {
	const unitName = systemdUnitName();
	const unitPath = systemdUnitPath(unitName);
	const existed = existsSync(unitPath);
	let stopped = false;
	if (systemdAvailable()) {
		if (options.start !== false) {
			systemctl(["disable", "--now", unitName]);
			stopped = true;
		} else {
			systemctl(["disable", unitName]);
		}
	}
	try {
		rmSync(unitPath, { force: true });
	} catch {
		// reported through `removed` below
	}
	if (systemdAvailable()) systemctl(["daemon-reload"]);
	markAutostartDisabled("removed with /webapp daemon uninstall");
	return { removed: existed && !existsSync(unitPath), unitPath, stopped };
}

/**
 * Idempotent convergence used on `session_start`: make sure the unit exists,
 * is enabled, and is running before the extension decides whether to host the
 * dashboard itself.
 */
export async function ensureAutostartService(
	options: { host?: string; port?: number; start?: boolean; install?: boolean; waitMs?: number } = {},
): Promise<AutostartResult> {
	if (!autostartPermittedByEnv()) {
		return { installed: false, changed: false, started: false, skipped: `${ENV.autostart} is off` };
	}
	const state = readAutostartState();
	if (state.disabledAt !== undefined) {
		return { installed: false, changed: false, started: false, skipped: "disabled by the user (/webapp daemon uninstall)" };
	}
	if (!systemdAvailable()) {
		return { installed: false, changed: false, started: false, skipped: "no systemd user session" };
	}

	const status = systemdServiceStatus();
	const host = options.host?.trim() || process.env[ENV.host]?.trim() || DEFAULT_HOST;
	const port = options.port ?? (Number(process.env[ENV.port]) || DEFAULT_PORT);

	if (status.installed && status.enabled && status.active) {
		return {
			installed: true,
			changed: false,
			started: await probeOrWait(dashboardUrlFor(host, port), 1_500),
			url: dashboardUrlFor(host, port),
			unitPath: status.unitPath,
		};
	}

	if (options.install === false) {
		return startSystemdService({ host, port, waitMs: options.waitMs });
	}

	const desired = buildSystemdUnit({ host, port });
	const existing = existsSync(status.unitPath) ? readFileSync(status.unitPath, "utf8") : null;
	const rewritten = existing !== desired;
	if (rewritten) {
		mkdirSync(path.dirname(status.unitPath), { recursive: true });
		writeFileSync(status.unitPath, desired, "utf8");
		systemctl(["daemon-reload"]);
	}
	if (!status.enabled) {
		const enabled = systemctl(["enable", status.unitName]);
		if (enabled.code !== 0) {
			return {
				installed: existsSync(status.unitPath),
				changed: rewritten,
				started: false,
				unitPath: status.unitPath,
				detail: enabled.stderr || enabled.stdout || `systemctl enable exited ${enabled.code}`,
			};
		}
	}

	let started = false;
	let detail: string | undefined;
	if (options.start !== false) {
		const start = systemctl(["start", status.unitName]);
		if (start.code === 0) {
			started = await probeOrWait(dashboardUrlFor(host, port), options.waitMs ?? 5_000);
			if (!started) detail = "service started but the dashboard is not answering yet";
		} else {
			detail = start.stderr || start.stdout || `systemctl start exited ${start.code}`;
		}
	}

	writeAutostartState({ installedAt: Date.now(), unitPath: status.unitPath });
	return {
		installed: existsSync(status.unitPath),
		changed: rewritten,
		started,
		url: dashboardUrlFor(host, port),
		unitPath: status.unitPath,
		detail,
	};
}

function dashboardUrlFor(host: string, port: number): string {
	const normalized = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
	const bracketed = normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
	return `http://${bracketed}:${port}`;
}

async function probeOrWait(url: string, timeoutMs: number): Promise<boolean> {
	return waitForHealth(url, timeoutMs);
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
	if (timeoutMs <= 0) return false;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await probeHealth(url)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** Local copy of the health probe so this module has no import cycle with daemonctl. */
async function probeHealth(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1_200);
		try {
			const response = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: controller.signal });
			return response.ok;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

/** Human-readable status block for `/webapp daemon status`. */
export function describeSystemdService(): string {
	const status = systemdServiceStatus();
	const lines = [
		`systemd user service: ${status.installed ? "installed" : "not installed"}`,
		`unit: ${status.unitPath}`,
	];
	if (status.available) {
		lines.push(`enabled: ${status.enabled ? "yes" : "no"}`, `active: ${status.active ? "yes" : "no"}`);
		lines.push(`logs: journalctl --user -u ${status.unitName} -f`);
	} else {
		lines.push(`systemd: ${status.detail ?? "unavailable"}`);
	}
	const state = readAutostartState();
	if (state.disabledAt) {
		lines.push(`autostart: disabled by the user (${state.disabledReason ?? "uninstall"})`);
	}
	return lines.join("\n");
}
