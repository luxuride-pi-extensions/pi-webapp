#!/usr/bin/env node
/**
 * `prepare` hook. Runs on `npm install` and on git installs (`pi install git:...`).
 *
 * Git installs use `--omit=dev`, so the build toolchain (typescript, esbuild,
 * tailwindcss) may not be available there, and lifecycle scripts can be
 * suppressed entirely. The repository therefore ships a prebuilt `dist/`, and
 * this script only rebuilds when that output is missing or when an explicit
 * rebuild is requested:
 *
 *   PI_WEBAPP_FORCE_BUILD=1 npm install
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const required = [
	join(root, "dist", "index.js"),
	join(root, "dist", "server.js"),
	join(root, "dist", "daemon.js"),
	join(root, "dist", "web", "app.js"),
	join(root, "dist", "web", "app.css"),
	join(root, "dist", "web", "index.html"),
];

const force = process.env.PI_WEBAPP_FORCE_BUILD === "1";
const missing = required.filter((file) => !existsSync(file));

if (!force && missing.length === 0) {
	console.log("[prepare] using the prebuilt dist/ bundle");
	process.exit(0);
}

if (missing.length > 0) {
	console.log(`[prepare] dist/ is incomplete (${missing.length} missing file(s)); rebuilding`);
}

const result = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], {
	cwd: root,
	stdio: "inherit",
});

if (result.error || result.status !== 0) {
	console.error(
		"[prepare] build failed. The packaged dist/ must be produced with devDependencies installed.\n" +
			"          Run `npm install && npm run build` in a checkout and commit dist/.",
	);
	process.exit(result.status ?? 1);
}
