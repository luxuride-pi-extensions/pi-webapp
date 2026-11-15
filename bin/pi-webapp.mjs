#!/usr/bin/env node
/**
 * CLI shim for the standalone dashboard.
 *
 * Runs the compiled entry point; `npm run build` produces dist/daemon.js and
 * `prepare` builds it automatically on `pi install` / `npm install`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, "..", "dist", "daemon.js");

if (!existsSync(entry)) {
	process.stderr.write(
		"pi-webapp: dist/daemon.js is missing — run `npm run build` (or `npm install`) first\n",
	);
	process.exit(1);
}

const { runCli } = await import(pathToFileURL(entry).href);
const result = await runCli(process.argv.slice(2));
if (result && Number.isInteger(result.code) && result.code !== 0) process.exit(result.code);
