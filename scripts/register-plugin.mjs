#!/usr/bin/env node
/**
 * Registers a plugin directory with a running dashboard. Intended for other pi
 * extensions and for the example plugins under examples/plugins/.
 *
 * usage: node scripts/register-plugin.mjs <dir> [--url http://127.0.0.1:8787]
 */
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const baseUrl = urlFlag >= 0 ? args[urlFlag + 1] : process.env.PI_WEBAPP_URL || "http://127.0.0.1:8787";
const dirInput = args.find((arg, index) => !arg.startsWith("--") && (urlFlag < 0 || index !== urlFlag + 1));

if (!dirInput) {
	console.error("usage: node scripts/register-plugin.mjs <dir> [--url http://127.0.0.1:8787]");
	process.exit(2);
}

const dir = realpathSync(path.resolve(dirInput));
const manifestPath = ["plugin.json", "pi-plugin.json", "manifest.json"]
	.map((name) => path.join(dir, name))
	.find((candidate) => {
		try {
			readFileSync(candidate);
			return true;
		} catch {
			return false;
		}
	});

if (!manifestPath) {
	console.error(`pi-webapp: no plugin.json found in ${dir}`);
	process.exit(1);
}

let manifest;
try {
	manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
	console.error(`pi-webapp: ${manifestPath} is not valid JSON: ${error.message}`);
	process.exit(1);
}
const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/plugins`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ ...manifest, dir }),
});

const body = await response.json().catch(() => null);
if (!response.ok) {
	console.error(`pi-webapp: registration failed (${response.status}): ${body?.error ?? "unknown error"}`);
	process.exit(1);
}
console.log(`pi-webapp: registered plugin ${body.plugin.id} (${body.plugin.panels.length} panel(s))`);
