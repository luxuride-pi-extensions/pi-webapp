import { constants as fsConstants } from "node:fs";
import { access, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BridgeRuntime } from "./bridge.js";
import {
	ENV,
	makeEvent,
	newId,
	truncate,
	type MediaAsset,
	type WebappEvent,
} from "./protocol.js";
import { getCacheRoot, ingestArtifact } from "./storage.js";

export interface ToolRuntime {
	sessionId: string;
	parentSessionId?: string;
	agentName?: string;
	isSubagent: boolean;
	cwd: string;
	getBridge: () => BridgeRuntime | null;
	emit: (event: WebappEvent) => void;
}

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_INSTALL_HINT =
	"Playwright is not installed. Install it with `npm i -D playwright && npx playwright install chromium` (or set PI_WEBAPP_PLAYWRIGHT to the playwright binary).";
const PLAYWRIGHT_CHECK_TIMEOUT_MS = 15_000;
const PLAYWRIGHT_CAPTURE_TIMEOUT_MS = 120_000;
const PLAYWRIGHT_MAX_BUFFER = 8 * 1024 * 1024;
const STDERR_TAIL_LENGTH = 600;
const DEFAULT_VIEWPORT = "1280x720";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function viewerUrlFor(baseUrl: string, sessionId: string): string {
	return `${baseUrl}/#session=${encodeURIComponent(sessionId)}`;
}

function absoluteArtifactUrl(baseUrl: string, relativeUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}${relativeUrl}`;
}

function stderrTail(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const stderr = (error as { stderr?: unknown }).stderr;
	if (typeof stderr !== "string") return "";
	const tail = stderr.trim().slice(-STDERR_TAIL_LENGTH);
	return tail;
}

function requireBridge(runtime: ToolRuntime): BridgeRuntime {
	const bridge = runtime.getBridge();
	if (!bridge) throw new Error("pi-webapp is not connected to a dashboard yet.");
	return bridge;
}

function buildWorkStateEvent(
	runtime: ToolRuntime,
	data: {
		title: string;
		description?: string;
		url?: string;
		media: MediaAsset[];
	},
): WebappEvent {
	return makeEvent({
		type: "work_state",
		sessionId: runtime.sessionId,
		parentSessionId: runtime.parentSessionId,
		agentName: runtime.agentName,
		isSubagent: runtime.isSubagent,
		data: {
			title: data.title,
			description: data.description,
			url: data.url,
			media: data.media,
		},
	});
}

function workStateText(
	runtime: ToolRuntime,
	bridge: BridgeRuntime,
	title: string,
	media: MediaAsset[],
): string {
	const lines = [`Posted "${title}" to the pi-webapp dashboard.`];
	lines.push(`Viewer: ${viewerUrlFor(bridge.url, runtime.sessionId)}`);
	if (media.length > 0) {
		lines.push("Artifacts:");
		for (const asset of media) {
			lines.push(`- ${absoluteArtifactUrl(bridge.url, asset.url)}`);
		}
	}
	return lines.join("\n");
}

export function createPostWorkStateTool(
	getRuntime: () => ToolRuntime,
): ToolDefinition {
	return defineTool({
		name: "post_work_state",
		label: "Post Work State",
		description:
			"Publish a visual milestone to the pi-webapp dashboard so a human can follow the work while it happens.",
		promptSnippet:
			"post_work_state — publish a milestone with a title, optional description/link and optional screenshot or recording.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1 }),
			description: Type.Optional(Type.String()),
			screenshotPath: Type.Optional(Type.String()),
			videoPath: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const runtime = getRuntime();
			const bridge = requireBridge(runtime);
			const media: MediaAsset[] = [];

			if (params.screenshotPath) {
				const sourcePath = path.resolve(runtime.cwd, params.screenshotPath);
				try {
					media.push(
						await ingestArtifact({
							root: getCacheRoot(),
							sessionId: runtime.sessionId,
							sourcePath,
							kind: "image",
						}),
					);
				} catch (error) {
					throw new Error(`Could not attach screenshot "${sourcePath}": ${errorMessage(error)}`);
				}
			}

			if (params.videoPath) {
				const sourcePath = path.resolve(runtime.cwd, params.videoPath);
				try {
					media.push(
						await ingestArtifact({
							root: getCacheRoot(),
							sessionId: runtime.sessionId,
							sourcePath,
							kind: "video",
						}),
					);
				} catch (error) {
					throw new Error(`Could not attach recording "${sourcePath}": ${errorMessage(error)}`);
				}
			}

			const event = buildWorkStateEvent(runtime, {
				title: params.title,
				description: params.description,
				url: params.url,
				media,
			});
			runtime.emit(event);

			return {
				content: [
					{
						type: "text" as const,
						text: workStateText(runtime, bridge, params.title, media),
					},
				],
				details: {
					eventId: event.id,
					sessionId: runtime.sessionId,
					viewerUrl: viewerUrlFor(bridge.url, runtime.sessionId),
					media,
				},
			};
		},
	});
}

interface PlaywrightCommand {
	command: string;
	prefixArgs: string[];
}

async function isExecutable(file: string): Promise<boolean> {
	try {
		await access(file, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function locatePlaywright(cwd: string): Promise<PlaywrightCommand | null> {
	const candidates = [
		process.env[ENV.playwright],
		path.join(cwd, "node_modules", ".bin", "playwright"),
		path.join(REPO_ROOT, "node_modules", ".bin", "playwright"),
	];
	for (const candidate of candidates) {
		if (candidate && (await isExecutable(candidate))) {
			return { command: candidate, prefixArgs: [] };
		}
	}
	try {
		await execFileAsync("npx", ["--no-install", "playwright", "--version"], {
			timeout: PLAYWRIGHT_CHECK_TIMEOUT_MS,
		});
		return { command: "npx", prefixArgs: ["--no-install", "playwright"] };
	} catch {
		return null;
	}
}

function parseViewport(raw: string | undefined): string {
	const value = raw ?? DEFAULT_VIEWPORT;
	const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
	if (!match) {
		throw new Error(`Invalid viewport "${value}" (expected WIDTHxHEIGHT, for example ${DEFAULT_VIEWPORT}).`);
	}
	return `${match[1]},${match[2]}`;
}

export function createCapturePlaywrightTool(
	getRuntime: () => ToolRuntime,
): ToolDefinition {
	return defineTool({
		name: "capture_playwright_snapshot",
		label: "Capture Playwright Snapshot",
		description:
			"Capture a screenshot of a running web app with Playwright and publish it to the pi-webapp dashboard.",
		promptSnippet:
			"capture_playwright_snapshot — screenshot a URL with Playwright and post it as a visual milestone.",
		parameters: Type.Object({
			targetUrl: Type.String({ pattern: "^https?://" }),
			title: Type.String({ minLength: 1 }),
			fullPage: Type.Optional(Type.Boolean({ default: false })),
			viewport: Type.Optional(Type.String({ pattern: "^\\d{2,5}x\\d{2,5}$" })),
			description: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const runtime = getRuntime();
			const bridge = requireBridge(runtime);
			const playwright = await locatePlaywright(runtime.cwd);
			if (!playwright) throw new Error(PLAYWRIGHT_INSTALL_HINT);

			const viewport = parseViewport(params.viewport);
			const outPath = path.join(os.tmpdir(), `pi-webapp-shot-${newId()}.png`);
			const args = [
				...playwright.prefixArgs,
				"screenshot",
				"--wait-for-timeout",
				"750",
				"--viewport-size",
				viewport,
				...(params.fullPage === true ? ["--full-page"] : []),
				params.targetUrl,
				outPath,
			];

			try {
				await execFileAsync(playwright.command, args, {
					cwd: runtime.cwd,
					timeout: PLAYWRIGHT_CAPTURE_TIMEOUT_MS,
					maxBuffer: PLAYWRIGHT_MAX_BUFFER,
					signal,
				});
			} catch (error) {
				const tail = stderrTail(error);
				throw new Error(
					`Playwright screenshot failed: ${errorMessage(error)}${tail ? `\n${truncate(tail, STDERR_TAIL_LENGTH)}` : ""}`,
				);
			}

			let media: MediaAsset[];
			try {
				media = [
					await ingestArtifact({
						root: getCacheRoot(),
						sessionId: runtime.sessionId,
						sourcePath: outPath,
						kind: "image",
					}),
				];
			} catch (error) {
				throw new Error(`Could not attach Playwright screenshot: ${errorMessage(error)}`);
			} finally {
				try {
					await unlink(outPath);
				} catch {
					// the temporary file may already be gone
				}
			}

			const description =
				params.description?.trim() || `Playwright screenshot of ${params.targetUrl}.`;
			const event = buildWorkStateEvent(runtime, {
				title: params.title,
				description,
				url: params.targetUrl,
				media,
			});
			runtime.emit(event);

			const lines = [
				`Captured "${params.title}" and posted it to the pi-webapp dashboard.`,
				`Viewer: ${viewerUrlFor(bridge.url, runtime.sessionId)}`,
			];
			for (const asset of media) {
				lines.push(`Artifact: ${absoluteArtifactUrl(bridge.url, asset.url)}`);
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: {
					eventId: event.id,
					sessionId: runtime.sessionId,
					viewerUrl: viewerUrlFor(bridge.url, runtime.sessionId),
					media,
				},
			};
		},
	});
}
