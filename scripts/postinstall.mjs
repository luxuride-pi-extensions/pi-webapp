#!/usr/bin/env node
/**
 * npm lifecycle hook: enable the pi-webapp dashboard as a **systemd user service**
 * so it starts at login and keeps running after every pi session ends.
 *
 * This path only runs when npm is allowed to execute lifecycle scripts. `pi
 * install` installs with `--omit=dev` and npm 12 blocks install scripts by
 * default, so the extension repeats the same convergence on `session_start`
 * (see src/systemd.ts). Both paths are idempotent and share one code path.
 *
 * The hook never fails an install: a missing systemd session, a container, or a
 * read-only config directory just prints a note and exits 0.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = ["1", "true", "yes", "on"].includes(
	String(process.env.PI_WEBAPP_POSTINSTALL_QUIET ?? "").trim().toLowerCase(),
);

function say(message) {
	if (!quiet) process.stdout.write(`pi-webapp: ${message}\n`);
}

function skip(reason) {
	say(`dashboard autostart not installed (${reason})`);
	process.exit(0);
}

if (process.platform !== "linux") skip("systemd is Linux-only");
if (["0", "false", "off", "no"].includes(String(process.env.PI_WEBAPP_AUTOSTART ?? "").trim().toLowerCase())) {
	skip("PI_WEBAPP_AUTOSTART is off");
}
if (["1", "true", "yes", "on"].includes(String(process.env.PI_WEBAPP_SKIP_AUTOSTART ?? "").trim().toLowerCase())) {
	skip("PI_WEBAPP_SKIP_AUTOSTART is set");
}
if (process.env.CI) skip("CI environment");

const entry = path.join(root, "dist", "systemd.js");
if (!existsSync(entry)) skip("dist/ is missing (the extension installs it on first run)");

try {
	const { ensureAutostartService } = await import(pathToFileURL(entry).href);
	const result = await ensureAutostartService({ start: true, waitMs: 8_000 });
	if (result.skipped) skip(result.skipped);
	say(
		result.changed
			? `dashboard autostart enabled (${result.unitPath})`
			: `dashboard autostart already enabled (${result.unitPath})`,
	);
	if (result.url) say(`dashboard: ${result.url}`);
	say(`disable with "/webapp daemon uninstall" inside pi, or: systemctl --user disable --now ${path.basename(result.unitPath ?? "pi-webapp.service")}`);
} catch (error) {
	// Never break `npm install` because the dashboard could not be registered.
	say(`dashboard autostart not installed: ${error instanceof Error ? error.message : String(error)}`);
}
process.exit(0);
