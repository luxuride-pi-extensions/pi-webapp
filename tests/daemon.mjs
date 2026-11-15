#!/usr/bin/env node
/**
 * End-to-end test for the standalone `pi-webapp serve` daemon.
 *
 * Boots `bin/pi-webapp.mjs serve` on a free loopback port with
 * PI_WEBAPP_PI_BIN pointed at a fake `pi` shell script, so no real pi process or
 * model call is involved. Walks the daemon contract: dashboard assets, spawn
 * state, starting a session, listing it, tailing its log, stopping it, then
 * SIGTERM shutdown and port release.
 *
 * Run with `node tests/daemon.mjs` (needs a build first: `npm run build`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WATCHDOG_MS = 60_000;
const POLL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const binPath = path.join(repoRoot, "bin", "pi-webapp.mjs");
const daemonEntry = path.join(repoRoot, "dist", "daemon.js");

if (!existsSync(daemonEntry)) {
	console.error("pi-webapp daemon test: dist/daemon.js is missing.");
	console.error('Run "npm run build" first.');
	process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitFor(label, check, timeoutMs = POLL_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let lastError = null;
	for (;;) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		if (Date.now() >= deadline) {
			const suffix = lastError ? `: ${lastError.message}` : "";
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
		}
		await sleep(POLL_INTERVAL_MS);
	}
}

function findFreePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			probe.close(() => (port > 0 ? resolve(port) : reject(new Error("could not allocate a free port"))));
		});
	});
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}

function waitForExit(child, timeoutMs, label) {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	}
	return withTimeout(
		new Promise((resolve, reject) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
			child.once("error", reject);
		}),
		timeoutMs,
		label,
	);
}

let daemon = null;
let daemonOutput = "";
let daemonExit = null;
let fakePiPid = 0;
let tmpRoot = null;

async function cleanup() {
	if (daemon) {
		try {
			if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
	if (fakePiPid > 0) {
		try {
			process.kill(fakePiPid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	if (tmpRoot) {
		try {
			await rm(tmpRoot, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
}

const watchdog = setTimeout(() => {
	console.error(`DAEMON FAIL: watchdog timeout after ${WATCHDOG_MS}ms`);
	void cleanup().finally(() => process.exit(1));
}, WATCHDOG_MS);

let failure = null;

try {
	console.log("▶ prepare temp dirs and fake pi");
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-webapp-daemon-"));
	const sessionCwd = path.join(tmpRoot, "session-cwd");
	await mkdir(sessionCwd, { recursive: true });
	const fakePi = path.join(tmpRoot, "fake-pi");
	// `exec` keeps the shell from orphaning the sleep, so SIGTERM kills the
	// whole fake session instead of leaving a stray process behind.
	await writeFile(fakePi, "#!/bin/sh\necho fake-pi-started\nexec sleep 30\n");
	await chmod(fakePi, 0o755);

	const leechDir = path.join(tmpRoot, "leech");
	await mkdir(leechDir, { recursive: true });

	const port = await findFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;

	console.log(`▶ start daemon on port ${port}`);
	daemon = spawn(process.execPath, [binPath, "serve", "--port", String(port)], {
		cwd: tmpRoot,
		env: {
			...process.env,
			PI_WEBAPP_PI_BIN: fakePi,
			PI_WEBAPP_HOST: "127.0.0.1",
			PI_WEBAPP_SPAWN: "1",
			PI_WEBAPP_LEECH: "1",
			PI_WEBAPP_LEECH_DIR: leechDir,
			PI_WEBAPP_CACHE_DIR: path.join(tmpRoot, "cache"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	daemon.stdout.on("data", (chunk) => {
		daemonOutput += chunk.toString("utf8");
	});
	daemon.stderr.on("data", (chunk) => {
		daemonOutput += chunk.toString("utf8");
	});
	daemon.once("exit", (code, signal) => {
		daemonExit = { code, signal };
	});

	await waitFor(
		`daemon "listening on" line (output so far: ${JSON.stringify(daemonOutput)})`,
		() => {
			if (daemonOutput.includes(`listening on ${baseUrl}`)) return true;
			if (daemonExit) {
				throw new Error(`daemon exited early (code ${daemonExit.code}, signal ${daemonExit.signal})`);
			}
			return false;
		},
		10_000,
	);

	console.log("▶ pid file");
	const pidFile = path.join(tmpRoot, "cache", "daemon.pid");
	const pidInfo = await waitFor("daemon pid file", () => {
		if (!existsSync(pidFile)) return null;
		try {
			const parsed = JSON.parse(readFileSync(pidFile, "utf8"));
			return typeof parsed.pid === "number" ? parsed : null;
		} catch {
			return null;
		}
	});
	assert.equal(pidInfo.pid, daemon.pid, "daemon.pid must record the running daemon pid");
	assert.equal(pidInfo.port, port, "daemon.pid must record the listening port");
	assert.equal(pidInfo.url, baseUrl, "daemon.pid must record the dashboard URL");

	console.log("▶ dashboard assets and spawn state");
	const indexResponse = await fetch(`${baseUrl}/`);
	assert.equal(indexResponse.status, 200, "GET / must serve the dashboard");
	assert.match(indexResponse.headers.get("content-type") ?? "", /text\/html/i);
	const indexHtml = await indexResponse.text();
	assert.ok(indexHtml.includes('id="app"'), 'dashboard HTML must mount into <div id="app">');

	const initialStateResponse = await fetch(`${baseUrl}/api/spawn`);
	assert.equal(initialStateResponse.status, 200, "GET /api/spawn");
	const initialState = await initialStateResponse.json();
	assert.equal(initialState.enabled, true, "the loopback daemon must allow spawning");
	const expectedCwd = await realpath(tmpRoot).catch(() => tmpRoot);
	assert.ok(
		initialState.defaultCwd === tmpRoot || initialState.defaultCwd === expectedCwd,
		`GET /api/spawn defaultCwd must be the daemon working dir, got ${initialState.defaultCwd}`,
	);
	assert.deepEqual(initialState.spawns, [], "GET /api/spawn must start empty");

	console.log("▶ start a session");
	const spawnResponse = await fetch(`${baseUrl}/api/spawn`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: sessionCwd, prompt: "hello" }),
	});
	const spawnBodyText = await spawnResponse.text();
	assert.equal(spawnResponse.status, 201, `POST /api/spawn -> ${spawnResponse.status}: ${spawnBodyText}`);
	const spawnBody = JSON.parse(spawnBodyText);
	assert.equal(spawnBody.ok, true, "POST /api/spawn must report ok: true");
	const spawnRecord = spawnBody.spawn;
	assert.ok(spawnRecord?.spawnId, "spawn record must carry a spawn id");
	assert.ok(Number.isInteger(spawnRecord.pid) && spawnRecord.pid > 0, "spawn record must carry the child pid");
	assert.ok(
		spawnRecord.status === "running" || spawnRecord.status === "starting",
		`spawn record must be running or starting, got ${spawnRecord.status}`,
	);
	assert.equal(spawnRecord.cwd, sessionCwd, "spawn record must keep the requested cwd");
	fakePiPid = spawnRecord.pid;

	const spawnsResponse = await fetch(`${baseUrl}/api/spawn`);
	assert.equal(spawnsResponse.status, 200, "GET /api/spawn after starting a session");
	const spawnsState = await spawnsResponse.json();
	const listed = spawnsState.spawns.find((record) => record.spawnId === spawnRecord.spawnId);
	assert.ok(listed, `GET /api/spawn must list ${spawnRecord.spawnId}`);
	assert.equal(listed.pid, fakePiPid, "listed spawn must keep its pid");

	console.log("▶ tail the spawn log");
	const logUrl = `${baseUrl}/api/spawn/${encodeURIComponent(spawnRecord.spawnId)}/log`;
	const logText = await waitFor("spawn log to contain fake-pi-started", async () => {
		const response = await fetch(logUrl);
		if (response.status !== 200) return null;
		const text = await response.text();
		return text.includes("fake-pi-started") ? text : null;
	});
	assert.ok(logText.includes("fake-pi-started"), "spawn log must show the fake pi output");

	console.log("▶ stop the session");
	const stopResponse = await fetch(`${baseUrl}/api/spawn/${encodeURIComponent(spawnRecord.spawnId)}`, {
		method: "DELETE",
	});
	assert.equal(stopResponse.status, 200, "DELETE /api/spawn/:id");
	assert.equal((await stopResponse.json()).ok, true, "DELETE /api/spawn/:id must report ok: true");

	const stoppedRecord = await waitFor("spawn to report exited or failed", async () => {
		const response = await fetch(`${baseUrl}/api/spawn`);
		if (response.status !== 200) return null;
		const state = await response.json();
		const record = state.spawns.find((item) => item.spawnId === spawnRecord.spawnId);
		return record && (record.status === "exited" || record.status === "failed") ? record : null;
	});
	assert.ok(
		stoppedRecord.status === "exited" || stoppedRecord.status === "failed",
		`stopped spawn must report exited or failed, got ${stoppedRecord.status}`,
	);

	console.log("▶ prompt an idle leeched session (implicit resume)");
	// A transcript nobody is running must be usable straight away: the first
	// prompt resumes it in a background pi process instead of requiring takeover.
	const leechedId = "aaaaaaaa-1111-4111-8111-aaaaaaaa1111";
	const leechFile = path.join(leechDir, `2026-01-01T00-00-00-000Z_${leechedId}.jsonl`);
	const leechStamp = new Date().toISOString();
	await writeFile(
		leechFile,
		`${[
			JSON.stringify({ type: "session", version: 3, id: leechedId, timestamp: leechStamp, cwd: sessionCwd }),
			JSON.stringify({
				type: "message",
				id: "leech-m1",
				parentId: null,
				timestamp: leechStamp,
				message: { role: "user", content: [{ type: "text", text: "earlier question" }] },
			}),
		].join("\n")}\n`,
	);
	const scanResponse = await fetch(`${baseUrl}/api/leech/scan`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ dirs: [leechDir] }),
	});
	assert.equal(scanResponse.status, 200, "POST /api/leech/scan");
	await waitFor("leeched session to appear", async () => {
		const state = await (await fetch(`${baseUrl}/api/state`)).json();
		return state.sessions.some((session) => session.id === leechedId);
	});
	const resumeResponse = await fetch(`${baseUrl}/api/sessions/${leechedId}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "pick up where we left off" }),
	});
	assert.equal(resumeResponse.status, 202, "prompting an idle leeched session must resume it");
	const resumeBody = await resumeResponse.json();
	assert.equal(resumeBody.delivered, "spawned", "resume must report delivered: spawned");
	assert.equal(resumeBody.spawn?.targetSessionId, leechedId, "resume spawn must target the leeched session");

	console.log("▶ SIGTERM the daemon");
	daemon.kill("SIGTERM");
	const exitInfo = await waitForExit(daemon, 5_000, "daemon to exit after SIGTERM");
	assert.equal(exitInfo.code, 0, `daemon must exit 0 after SIGTERM, got code ${exitInfo.code} signal ${exitInfo.signal}`);

	await waitFor(`port ${port} to be released`, () => isPortFree(port), 5_000);
	assert.equal(existsSync(pidFile), false, "the daemon must remove its pid file on shutdown");
} catch (error) {
	failure = error;
} finally {
	clearTimeout(watchdog);
	await cleanup();
}

if (failure) {
	console.error(`DAEMON FAIL: ${failure.message}`);
	if (daemonOutput.trim()) {
		console.error("--- daemon output ---");
		console.error(daemonOutput.trim());
	}
	process.exit(1);
}

console.log("\nDAEMON OK");
process.exit(0);
