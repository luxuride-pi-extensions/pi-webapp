/**
 * Autostart test.
 *
 * Part 1 is pure: the generated systemd unit must contain the flags that make
 * service mode work (--wait, environment plumbing, restart policy).
 *
 * Part 2 drives a real `systemctl --user` cycle with a throwaway unit name and
 * a throwaway port, so it never touches the user's real pi-webapp service. It
 * is skipped (exit 0) where no systemd user session exists, e.g. containers.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
if (!existsSync(path.join(dist, "systemd.js"))) {
	console.error("build first: npm run build");
	process.exit(1);
}

const { buildSystemdUnit, systemdAvailable } = await import(path.join(dist, "systemd.js"));

function systemctl(args) {
	return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15_000 });
}

const unit = buildSystemdUnit({ host: "127.0.0.1", port: 8799 });
assert.match(unit, /^\[Unit\]/, "unit starts with [Unit]");
assert.match(unit, /ExecStart=.*bin\/pi-webapp\.mjs serve --wait --host 127\.0\.0\.1 --port 8799/);
assert.match(unit, /Environment=PI_WEBAPP_HOST=127\.0\.0\.1/);
assert.match(unit, /Environment=PI_WEBAPP_PORT=8799/);
assert.match(unit, /Environment=PI_WEBAPP_PI_BIN=/);
assert.match(unit, /Environment=PATH=/);
assert.match(unit, /WorkingDirectory=\//);
assert.match(unit, /Restart=on-failure/);
assert.match(unit, /WantedBy=default\.target/);
assert.match(unit, /StartLimitIntervalSec=0/);
console.log("unit content ok");

const postinstall = spawnSync(process.execPath, [path.join(root, "scripts", "postinstall.mjs")], {
	encoding: "utf8",
	env: { ...process.env, PI_WEBAPP_AUTOSTART: "off" },
	timeout: 30_000,
});
assert.equal(postinstall.status, 0, `postinstall must exit 0 even when skipping: ${postinstall.stderr}`);
assert.match(postinstall.stdout, /autostart not installed \(PI_WEBAPP_AUTOSTART is off\)/, postinstall.stdout);
console.log("postinstall skip path ok");

if (!systemdAvailable()) {
	console.log("AUTOSTART SKIP (no systemd user session)");
	process.exit(0);
}

const unitName = `pi-webapp-test-${process.pid}.service`;
const port = 8800 + (process.pid % 90);
// The systemd *user manager* resolves unit files from its own environment, so a
// temporary XDG_CONFIG_HOME is invisible to it. Use a throwaway unit name in the
// real unit directory instead; everything is removed again in `finally`.
const cacheHome = mkdtempSync(path.join(tmpdir(), "pi-webapp-cache-"));

const previousUnit = process.env.PI_WEBAPP_SYSTEMD_UNIT;
const previousCache = process.env.PI_WEBAPP_CACHE_DIR;
process.env.PI_WEBAPP_SYSTEMD_UNIT = unitName;
process.env.PI_WEBAPP_CACHE_DIR = cacheHome;
process.env.PI_WEBAPP_PORT = String(port);

const { ensureAutostartService, readAutostartState, uninstallSystemdService, systemdServiceStatus, systemdUnitPath } =
	await import(path.join(dist, "systemd.js"));
const unitPath = systemdUnitPath(unitName);

let installed = false;
try {
	const result = await ensureAutostartService({ start: true, waitMs: 10_000 });
	installed = result.installed;

	assert.equal(result.installed, true, `unit not installed: ${JSON.stringify(result)}`);
	assert.equal(existsSync(unitPath), true, "unit file missing");
	assert.match(readFileSync(unitPath, "utf8"), /--wait --host 127\.0\.0\.1/, "unit content stale");
	assert.equal(systemctl(["is-enabled", unitName]).stdout.trim(), "enabled", "unit is not enabled");
	assert.equal(systemctl(["is-active", unitName]).stdout.trim(), "active", "unit is not active");

	const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok);
	assert.equal(health, true, "dashboard did not answer on the service port");
	console.log(`service ok on port ${port}`);

	// Idempotency: a second call must not rewrite the unit or restart the service.
	const again = await ensureAutostartService({ start: true, waitMs: 3_000 });
	assert.equal(again.changed, false, "second ensure rewrote the unit");
	assert.equal(systemdServiceStatus().active, true, "service stopped after second ensure");

	// A second daemon on the same port keeps waiting instead of dying.
	const busy = spawnSync(process.execPath, [path.join(root, "bin", "pi-webapp.mjs"), "serve", "--wait", "--port", String(port)], {
		encoding: "utf8",
		timeout: 4_000,
		env: { ...process.env, PI_WEBAPP_PORT: String(port) },
	});
	assert.equal(busy.signal, "SIGTERM", "waiting daemon exited on its own");
	assert.match(busy.stdout, /dashboard port is busy, waiting/, busy.stdout);
	console.log("busy-port wait ok");

	const removed = uninstallSystemdService();
	assert.equal(removed.removed, true, "unit file was not removed");
	assert.equal(existsSync(unitPath), false, "unit file still present");
	assert.notEqual(systemctl(["is-active", unitName]).stdout.trim(), "active", "unit still active after uninstall");
	assert.ok(readAutostartState().disabledAt, "uninstall did not record the opt-out");
	console.log("uninstall ok");

	const reenabled = await ensureAutostartService({ start: false });
	assert.equal(reenabled.installed, false, "ensure re-installed after an explicit uninstall");
	assert.match(String(reenabled.skipped ?? ""), /disabled by the user/, "opt-out reason missing");
	installed = false;
	console.log("opt-out respected");
} finally {
	if (installed) {
		try {
			systemctl(["disable", "--now", unitName]);
		} catch {
			// ignore
		}
		try {
			rmSync(unitPath, { force: true });
			systemctl(["daemon-reload"]);
		} catch {
			// ignore
		}
	}
	rmSync(cacheHome, { recursive: true, force: true });
	if (previousUnit === undefined) delete process.env.PI_WEBAPP_SYSTEMD_UNIT;
	else process.env.PI_WEBAPP_SYSTEMD_UNIT = previousUnit;
	if (previousCache === undefined) delete process.env.PI_WEBAPP_CACHE_DIR;
	else process.env.PI_WEBAPP_CACHE_DIR = previousCache;
}

console.log("AUTOSTART OK");
