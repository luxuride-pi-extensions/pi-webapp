#!/usr/bin/env node
/**
 * End-to-end smoke test for pi-wabapp.
 *
 * Boots a real WabappServer on an ephemeral loopback port and walks the public
 * wire contract: static dashboard assets, event ingestion, WebSocket snapshot /
 * broadcast, HTTP Range video streaming, prompt routing (local, instance and
 * leech), multi-instance routing and leech tailing of pi session files.
 *
 * The test imports the compiled server (`dist/server.js`, `dist/storage.js`),
 * so it needs a build first: `npm run build`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const WATCHDOG_MS = 60_000;
const STEP_TIMEOUT_MS = 3_000;
const POLL_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const distDir = path.join(repoRoot, "dist");

const requiredDist = ["server.js", "storage.js", "protocol.js"];
const missingDist = requiredDist.filter((file) => !existsSync(path.join(distDir, file)));
if (missingDist.length > 0) {
	console.error(`pi-wabapp smoke test: dist/ is missing ${missingDist.join(", ")}.`);
	console.error('Run "npm run build" first.');
	process.exit(1);
}

const { WabappServer } = await import(pathToFileURL(path.join(distDir, "server.js")).href);
const { ingestArtifact } = await import(pathToFileURL(path.join(distDir, "storage.js")).href);

// A 1x1 transparent PNG, used as a real artifact upload payload.
const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const parentId = "parent-1";
const childId = "child-1";
const leechId = "leech-1";
const remoteId = "remote-1";

let currentStep = "bootstrap";
let exitCode = 0;

const sockets = new Set();
let server = null;
let serverPort = 0;
let tmpRoot = null;
let artifactsRoot = null;
let leechDir = null;
let baseUrl = "";

function step(name) {
	currentStep = name;
	console.log(`▶ ${name}`);
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

let eventCounter = 0;

function makeEvent(type, sessionId, extra = {}) {
	eventCounter += 1;
	return { id: `evt-smoke-${eventCounter}`, type, sessionId, timestamp: Date.now(), ...extra };
}

async function postEvent(instanceId, event) {
	const response = await fetch(`${baseUrl}/api/events`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ instanceId, event }),
	});
	const body = await response.text();
	assert.equal(response.status, 200, `POST /api/events ${event.type} -> ${response.status}: ${body}`);
	return body;
}

async function getState() {
	const response = await fetch(`${baseUrl}/api/state`);
	assert.equal(response.status, 200, "GET /api/state");
	return response.json();
}

/** Minimal WebSocket test client that buffers incoming messages until awaited. */
function connectSocket(url) {
	const ws = new WebSocket(url);
	sockets.add(ws);
	const inbox = [];
	const waiters = [];

	ws.on("message", (raw) => {
		const message = JSON.parse(raw.toString());
		const index = waiters.findIndex((waiter) => waiter.predicate(message));
		if (index >= 0) {
			const [waiter] = waiters.splice(index, 1);
			waiter.resolve(message);
		} else {
			inbox.push(message);
		}
	});
	ws.on("close", () => {
		for (const waiter of waiters.splice(0)) {
			waiter.reject(new Error(`socket closed while waiting for ${waiter.label}`));
		}
	});
	ws.on("error", (error) => {
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	});

	const opened = new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});

	function waitForMessage(predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
		const index = inbox.findIndex((message) => predicate(message));
		if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
		let entry;
		const pending = new Promise((resolve, reject) => {
			entry = { predicate, resolve, reject, label };
			waiters.push(entry);
		});
		return withTimeout(pending, timeoutMs, label).catch((error) => {
			const pendingIndex = waiters.indexOf(entry);
			if (pendingIndex >= 0) waiters.splice(pendingIndex, 1);
			throw error;
		});
	}

	return {
		ws,
		opened: withTimeout(opened, STEP_TIMEOUT_MS, `websocket open ${url}`),
		send: (message) => ws.send(JSON.stringify(message)),
		waitForMessage,
		close: () => {
			sockets.delete(ws);
			try {
				ws.close();
			} catch {
				// already closed
			}
			ws.terminate();
		},
	};
}

async function expectTraversalBlocked(url) {
	const response = await fetch(url);
	assert.ok(
		[400, 403, 404].includes(response.status),
		`${url} must be rejected with 400/403/404, got ${response.status}`,
	);
	const body = await response.text();
	assert.ok(!body.includes("root:"), `${url} leaked /etc/passwd contents`);
}

const watchdog = setTimeout(() => {
	console.error(`\n✗ SMOKE FAILED at step "${currentStep}": watchdog timeout after ${WATCHDOG_MS}ms`);
	process.exit(1);
}, WATCHDOG_MS);

try {
	step("prepare temp dirs");
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-wabapp-smoke-"));
	artifactsRoot = path.join(tmpRoot, "artifacts");
	leechDir = path.join(tmpRoot, "leech");
	await mkdir(artifactsRoot, { recursive: true });
	await mkdir(leechDir, { recursive: true });

	step("1. start server");
	server = new WabappServer({
		host: "127.0.0.1",
		port: 0,
		artifactsRoot,
		leech: { enabled: true, dirs: [leechDir], intervalMs: 150 },
	});
	const boundPort = await server.start();
	assert.ok(typeof boundPort === "number" && boundPort > 0, "server.start() must report an ephemeral port");
	serverPort = server.port;
	assert.ok(serverPort > 0, `server.port must be > 0, got ${serverPort}`);
	assert.equal(serverPort, boundPort, "server.port must report the port returned by start()");
	baseUrl = `http://127.0.0.1:${serverPort}`;
	assert.ok(
		server.url.startsWith(baseUrl),
		`server.url must start with ${baseUrl}, got ${server.url}`,
	);

	step("2. static dashboard assets");
	const indexResponse = await fetch(`${baseUrl}/`);
	assert.equal(indexResponse.status, 200, "GET /");
	assert.match(indexResponse.headers.get("content-type") ?? "", /text\/html/i);
	const indexHtml = await indexResponse.text();
	assert.ok(indexHtml.includes('id="app"'), 'dashboard HTML must mount into <div id="app">');

	const jsResponse = await fetch(`${baseUrl}/app.js`);
	assert.equal(jsResponse.status, 200, "GET /app.js");
	assert.match(jsResponse.headers.get("content-type") ?? "", /javascript/i);

	const cssResponse = await fetch(`${baseUrl}/app.css`);
	assert.equal(cssResponse.status, 200, "GET /app.css");
	assert.match(cssResponse.headers.get("content-type") ?? "", /css/i);

	const healthResponse = await fetch(`${baseUrl}/api/health`);
	assert.equal(healthResponse.status, 200, "GET /api/health");
	const health = await healthResponse.json();
	assert.equal(health.ok, true, "/api/health must report ok: true");

	step("3. ingest session, subagent and work_state events");
	const localPrompts = [];
	server.setLocalPromptHandler((command) => {
		localPrompts.push(command);
		return command.sessionId === parentId;
	});

	await postEvent(
		"local-1",
		makeEvent("session_started", parentId, {
			data: { cwd: "/tmp/demo", title: "Demo parent", agentName: "pi" },
		}),
	);
	await postEvent(
		"local-1",
		makeEvent("subagent_spawned", parentId, {
			data: {
				childSessionId: childId,
				agentName: "scout",
				task: "Inspect the login page",
				callId: "call-1",
			},
		}),
	);

	const pngPath = path.join(tmpRoot, "screenshot.png");
	await writeFile(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"));
	const asset = await ingestArtifact({ root: artifactsRoot, sessionId: parentId, sourcePath: pngPath, kind: "image" });
	assert.equal(asset.kind, "image", "ingestArtifact must report an image asset");
	assert.ok(asset.bytes > 0, "ingestArtifact must report a non-empty asset");
	assert.match(asset.url, /^\/artifacts\//, "asset URLs are served below /artifacts/");

	// The child posts its visual state first, then reports completion.
	await postEvent(
		"local-1",
		makeEvent("work_state", childId, {
			parentSessionId: parentId,
			agentName: "scout",
			isSubagent: true,
			data: { media: [asset] },
		}),
	);
	await postEvent(
		"local-1",
		makeEvent("subagent_completed", childId, {
			parentSessionId: parentId,
			agentName: "scout",
			isSubagent: true,
			data: { status: "completed", summary: "found 3 issues", durationMs: 1234 },
		}),
	);

	const assetResponse = await fetch(`${baseUrl}${asset.url}`);
	assert.equal(assetResponse.status, 200, `GET ${asset.url}`);
	assert.match(assetResponse.headers.get("content-type") ?? "", /image\/png/i);
	assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, "served artifact must have a body");

	const state = await getState();
	assert.equal(state.sessions.length, 2, `expected 2 sessions, got ${state.sessions.length}`);
	const parentNode = state.sessions.find((node) => node.id === parentId);
	const childNode = state.sessions.find((node) => node.id === childId);
	assert.ok(parentNode, `missing parent session ${parentId}`);
	assert.ok(childNode, `missing child session ${childId}`);
	assert.equal(childNode.parentSessionId, parentId, "child must point at its parent session");
	assert.equal(childNode.status, "completed", "child must be completed after subagent_completed");

	const workStateEvent = state.events.find((event) => event.type === "work_state" && event.sessionId === childId);
	assert.ok(workStateEvent, "work_state event must be stored in the event history");
	const workStateMedia = workStateEvent.data?.media;
	assert.ok(Array.isArray(workStateMedia) && workStateMedia.length > 0, "work_state must carry media entries");
	assert.match(workStateMedia[0].url, /^\/artifacts\//, "work_state media URL must start with /artifacts/");

	step("4. websocket snapshot + live broadcast");
	const uiSocket = connectSocket(`ws://127.0.0.1:${serverPort}/ws`);
	await uiSocket.opened;
	const snapshot = await uiSocket.waitForMessage((message) => message.type === "snapshot", "snapshot");
	assert.ok(Array.isArray(snapshot.state?.sessions), "snapshot must carry the server state");
	assert.equal(snapshot.state.sessions.length, 2, "snapshot must include the ingested sessions");

	const liveEventId = `evt-ui-prompt-${Date.now()}`;
	await postEvent(
		"local-1",
		{ id: liveEventId, type: "user_prompt", sessionId: parentId, timestamp: Date.now(), data: { text: "ping from smoke test" } },
	);
	const broadcast = await uiSocket.waitForMessage(
		(message) => message.type === "event" && message.event?.id === liveEventId,
		`broadcast of ${liveEventId}`,
	);
	assert.equal(broadcast.event.sessionId, parentId, "broadcast event must keep its session id");
	uiSocket.close();

	step("5. HTTP Range artifact streaming");
	const clipDir = path.join(artifactsRoot, parentId);
	await mkdir(clipDir, { recursive: true });
	const clipBytes = Buffer.alloc(64);
	for (let index = 0; index < clipBytes.length; index++) clipBytes[index] = index;
	await writeFile(path.join(clipDir, "clip.webm"), clipBytes);
	const clipPath = `/artifacts/${parentId}/clip.webm`;

	const rangeResponse = await fetch(`${baseUrl}${clipPath}`, { headers: { Range: "bytes=10-19" } });
	assert.equal(rangeResponse.status, 206, "byte range must answer 206");
	assert.equal(rangeResponse.headers.get("content-range"), "bytes 10-19/64");
	assert.equal(rangeResponse.headers.get("content-length"), "10");
	assert.deepEqual(
		Buffer.from(await rangeResponse.arrayBuffer()),
		clipBytes.subarray(10, 20),
		"range body must be bytes 10..19",
	);

	const suffixResponse = await fetch(`${baseUrl}${clipPath}`, { headers: { Range: "bytes=-8" } });
	assert.equal(suffixResponse.status, 206, "suffix range must answer 206");
	assert.equal((await suffixResponse.arrayBuffer()).byteLength, 8, "suffix range must return 8 bytes");

	const openRangeResponse = await fetch(`${baseUrl}${clipPath}`, { headers: { Range: "bytes=999-" } });
	assert.equal(openRangeResponse.status, 416, "unsatisfiable range must answer 416");
	assert.equal(openRangeResponse.headers.get("content-range"), "bytes */64");

	const fullResponse = await fetch(`${baseUrl}${clipPath}`);
	assert.equal(fullResponse.status, 200, "full GET must answer 200");
	assert.equal(fullResponse.headers.get("accept-ranges"), "bytes");
	const fullBody = Buffer.from(await fullResponse.arrayBuffer());
	assert.equal(fullBody.byteLength, 64, "full GET must return the whole clip");

	await expectTraversalBlocked(`${baseUrl}/artifacts/${parentId}/..%2f..%2fetc%2fpasswd`);
	await expectTraversalBlocked(`${baseUrl}/artifacts/..%2f..%2fetc/passwd`);

	step("6. prompt delivery guards");
	const promptResponse = await fetch(`${baseUrl}/api/sessions/${parentId}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "look at the footer", deliverAs: "steer" }),
	});
	assert.equal(promptResponse.status, 200, "POST prompt to a live session");
	const promptBody = await promptResponse.json();
	assert.equal(promptBody.ok, true);
	assert.equal(promptBody.delivered, "local");
	const handled = localPrompts.find((command) => command.text === "look at the footer");
	assert.ok(handled, "local prompt handler must receive the prompt");
	assert.equal(handled.deliverAs, "steer", "deliverAs must be forwarded to the handler");

	const unknownResponse = await fetch(`${baseUrl}/api/sessions/does-not-exist/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "hello", deliverAs: "auto" }),
	});
	assert.equal(unknownResponse.status, 404, "prompt to an unknown session must answer 404");

	await postEvent(
		"local-1",
		makeEvent("session_started", leechId, {
			source: "leech",
			data: { cwd: "/tmp/leech-demo", title: "Leech session" },
		}),
	);
	const leechPromptResponse = await fetch(`${baseUrl}/api/sessions/${leechId}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "cannot steer history", deliverAs: "steer" }),
	});
	assert.equal(leechPromptResponse.status, 409, "prompt to a leeched session must answer 409");

	step("7. multi-instance routing");
	const instanceSocket = connectSocket(`ws://127.0.0.1:${serverPort}/ws?role=instance&instanceId=inst-2`);
	await instanceSocket.opened;
	instanceSocket.send({ type: "hello", role: "instance", instanceId: "inst-2" });
	const helloOk = await instanceSocket.waitForMessage((message) => message.type === "hello_ok", "hello_ok");
	assert.equal(helloOk.instanceId, "inst-2", "hello_ok must echo the instance id");

	await postEvent(
		"inst-2",
		makeEvent("session_started", remoteId, { data: { cwd: "/tmp/remote", title: "Remote session" } }),
	);
	const remotePromptResponse = await fetch(`${baseUrl}/api/sessions/${remoteId}/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "remote question from smoke test", deliverAs: "followUp" }),
	});
	assert.equal(remotePromptResponse.status, 202, "prompt owned by another instance must answer 202");
	const remotePromptBody = await remotePromptResponse.json();
	assert.equal(remotePromptBody.delivered, "instance", "prompt must be routed to the owning instance");

	const commandMessage = await instanceSocket.waitForMessage(
		(message) => message.type === "command" && message.command?.sessionId === remoteId,
		"command for remote session",
	);
	assert.equal(commandMessage.command.text, "remote question from smoke test");
	instanceSocket.send({ type: "command_ack", commandId: commandMessage.command.id, ok: true });
	instanceSocket.close();

	step("8. leech session files");
	const leechProjectDir = path.join(leechDir, "--tmp-demo--");
	await mkdir(leechProjectDir, { recursive: true });
	const leechFile = path.join(leechProjectDir, "2026-01-01T00-00-00-000Z_leech-1.jsonl");
	const stamp = "2026-01-01T00:00:00.000Z";
	const leechHeader = { type: "session", version: 3, id: leechId, timestamp: stamp, cwd: "/tmp/leech-demo" };
	const leechUser = {
		type: "message",
		id: "leech-msg-1",
		parentId: null,
		timestamp: stamp,
		message: { role: "user", content: [{ type: "text", text: "Leech me a question" }] },
	};
	const leechAssistant = {
		type: "message",
		id: "leech-msg-2",
		parentId: "leech-msg-1",
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Leeched hello" }],
			model: "claude-sonnet-4",
			provider: "anthropic",
		},
	};
	const lines = [leechHeader, leechUser, leechAssistant].map((line) => JSON.stringify(line));
	await writeFile(leechFile, `${lines.join("\n")}\n`);

	const leechedSession = await waitFor("leeched session with assistant text", async () => {
		const current = await getState();
		const node = current.sessions.find((session) => session.id === leechId && session.source === "leech");
		if (!node) return null;
		const hasAssistant = current.events.some(
			(event) =>
				event.type === "assistant_message" &&
				event.sessionId === leechId &&
				JSON.stringify(event.data).includes("Leeched hello"),
		);
		return hasAssistant ? current : null;
	});
	assert.equal(leechedSession.leech.enabled, true, "leech must be enabled");
	assert.ok(leechedSession.leech.sessions >= 1, "leech status must count the parsed session");

	const followUpText = "second question from the smoke test";
	const followUpLine = {
		type: "message",
		id: "leech-msg-3",
		parentId: "leech-msg-2",
		timestamp: "2026-01-01T00:00:05.000Z",
		message: { role: "user", content: [{ type: "text", text: followUpText }] },
	};
	await writeFile(leechFile, `${lines.join("\n")}\n${JSON.stringify(followUpLine)}\n`);

	await waitFor("appended leech user message", async () => {
		const current = await getState();
		return current.events.some(
			(event) =>
				event.type === "user_prompt" &&
				event.sessionId === leechId &&
				JSON.stringify(event.data).includes(followUpText),
		);
	});

	const scanResponse = await fetch(`${baseUrl}/api/leech/scan`, { method: "POST" });
	assert.equal(scanResponse.status, 200, "POST /api/leech/scan");
	const scanBody = await scanResponse.json();
	assert.equal(scanBody.enabled, true, "leech scan response must report enabled: true");
} catch (error) {
	exitCode = 1;
	console.error(`\n✗ SMOKE FAILED at step "${currentStep}":`);
	console.error(error?.stack ?? String(error));
} finally {
	clearTimeout(watchdog);
	step("9. cleanup");
	try {
		await cleanup();
	} catch (error) {
		exitCode = 1;
		console.error(`\n✗ SMOKE FAILED at step "${currentStep}":`);
		console.error(error?.stack ?? String(error));
	}
}

if (exitCode === 0) {
	console.log("\nSMOKE OK");
}
process.exit(exitCode);

async function cleanup() {
	const errors = [];
	for (const socket of [...sockets]) {
		sockets.delete(socket);
		try {
			socket.close();
			socket.terminate();
		} catch {
			// socket already gone
		}
	}
	if (server) {
		try {
			await withTimeout(server.stop(), 5_000, "server.stop()");
		} catch (error) {
			errors.push(error);
		}
		server = null;
	}
	if (serverPort > 0) {
		try {
			const probe = new WabappServer({ host: "127.0.0.1", port: serverPort, artifactsRoot, leech: false });
			const probePort = await probe.start();
			assert.equal(probePort, serverPort, "second server must bind the released port");
			await probe.stop();
		} catch (error) {
			errors.push(new Error(`port ${serverPort} was not released after stop(): ${error?.message ?? error}`));
		}
	}
	if (tmpRoot) {
		try {
			await rm(tmpRoot, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) throw errors[0];
}
