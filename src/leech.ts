/**
 * Session leech: tail pi session JSONL files on disk and turn newly appended
 * entries into WebappEvents. This lets the dashboard observe pi processes that
 * do not load the extension (and therefore never report live events).
 *
 * Live in-process events remain authoritative in the server; leeched events are
 * always marked with source "leech" so consumers can prefer live data.
 */

import type { Dirent, Stats } from "node:fs";
import { open, readdir, stat as statFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import {
	type LeechStatus,
	type WebappEvent,
	type WebappEventData,
	type WebappEventType,
	bool,
	makeEvent,
	num,
	str,
	truncate,
	WATCH_INTERVAL_MS,
} from "./protocol.js";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REPLAY_LIMIT = 40;
const MAX_SCAN_DEPTH = 4;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SEEN_ENTRY_IDS = 5000;
const MAX_PROMPT_CHARS = 8000;
const MAX_MESSAGE_CHARS = 8000;
const MAX_THINKING_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 1500;
const MAX_TOOL_HINT_CHARS = 200;
const HEADER_READ_BYTES = 64 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);

const TOOL_HINT_KEYS = ["command", "file_path", "path", "pattern", "url", "prompt"] as const;

export interface SessionLeechOptions {
	dirs: string[];
	intervalMs?: number;
	maxAgeMs?: number;
	replayLimit?: number;
	ignoreSession?: (id: string) => boolean;
	onEvent: (event: WebappEvent) => void;
}

interface HeaderInfo {
	id: string;
	cwd: string;
	timestamp: string;
	version: number;
	parentSession?: string;
}

interface FileState {
	path: string;
	sessionId: string;
	header: HeaderInfo;
	ino: number;
	/** Byte offset of the end of the last read chunk. */
	offset: number;
	/** Bytes of a trailing line that has not been terminated yet. */
	pendingBuffer: Buffer;
	seenEntryIds: Set<string>;
	mtimeMs: number;
	emittedStart: boolean;
	/** True while the first-sight replay buffer is still being collected. */
	replaying: boolean;
	replayBuffer: WebappEvent[];
	model: string;
	parentSessionPath?: string;
	parentSessionId?: string;
}

interface ToolCallInfo {
	id: string;
	name: string;
	arguments: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

function parseTimestamp(value: string, fallback: number): number {
	const parsed = Date.parse(value);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return fallback > 0 ? fallback : Date.now();
}

function sessionTitle(cwd: string, sessionId: string): string {
	const short = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
	const base = cwd ? basename(cwd) : "";
	if (!base || base === "." || base === "/") return short;
	return `${base} · ${short}`;
}

function modelLabel(provider: string, model: string): string {
	if (provider && model) return `${provider}/${model}`;
	return model || provider;
}

function compactHint(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function toolHint(value: unknown): string {
	const record = asRecord(value);
	if (record) {
		for (const key of TOOL_HINT_KEYS) {
			const candidate = record[key];
			if (typeof candidate !== "string") continue;
			const hint = compactHint(candidate);
			if (hint) return truncate(hint, MAX_TOOL_HINT_CHARS);
		}
		return "";
	}
	if (typeof value === "string") {
		const hint = compactHint(value);
		if (hint) return truncate(hint, MAX_TOOL_HINT_CHARS);
	}
	return "";
}

/** Join the text items of a message content value. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			parts.push(item);
			continue;
		}
		const record = asRecord(item);
		if (!record || record.type !== "text") continue;
		const text = str(record.text);
		if (text) parts.push(text);
	}
	return parts.join("\n");
}

function assistantParts(content: unknown): { text: string; thinking: string; toolCalls: ToolCallInfo[] } {
	const texts: string[] = [];
	const thinkings: string[] = [];
	const toolCalls: ToolCallInfo[] = [];
	if (Array.isArray(content)) {
		for (const item of content) {
			const record = asRecord(item);
			if (!record) continue;
			if (record.type === "text") {
				const text = str(record.text);
				if (text) texts.push(text);
			} else if (record.type === "thinking") {
				const thinking = str(record.thinking);
				if (thinking) thinkings.push(thinking);
			} else if (record.type === "toolCall") {
				toolCalls.push({
					id: str(record.id),
					name: str(record.name),
					arguments: record.arguments,
				});
			}
		}
	}
	return { text: texts.join("\n"), thinking: thinkings.join("\n"), toolCalls };
}

async function readHeader(filePath: string): Promise<HeaderInfo | null> {
	try {
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
			if (bytesRead <= 0) return null;
			const text = buffer.subarray(0, bytesRead).toString("utf8");
			const newline = text.indexOf("\n");
			const line = (newline >= 0 ? text.slice(0, newline) : text).trim();
			if (!line) return null;
			const record = asRecord(JSON.parse(line));
			if (!record || record.type !== "session") return null;
			const id = str(record.id);
			if (!id) return null;
			const header: HeaderInfo = {
				id,
				cwd: str(record.cwd),
				timestamp: str(record.timestamp),
				version: num(record.version),
			};
			const parentSession = str(record.parentSession);
			if (parentSession) header.parentSession = parentSession;
			return header;
		} finally {
			await handle.close().catch(() => {});
		}
	} catch {
		return null;
	}
}

/**
 * Tails `*.jsonl` session files below the configured directories.
 *
 * A file is tracked once its first line parses as a pi session header. On the
 * first sight the whole file (or its last 8 MB) is read and only the most
 * recent `replayLimit` events are emitted, after `session_started`. Later scans
 * read from the tracked byte offset and emit every new entry.
 */
export class SessionLeech {
	private readonly dirs: string[];
	private readonly intervalMs: number;
	private readonly maxAgeMs: number;
	private readonly replayLimit: number;
	private readonly ignoreSession?: (id: string) => boolean;
	private readonly onEvent: (event: WebappEvent) => void;

	private readonly files = new Map<string, FileState>();
	private readonly sessionIds = new Set<string>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private scanPromise: Promise<void> | null = null;
	private lastScanAt: number | undefined;
	private lastError: string | undefined;
	private malformedLines = 0;

	constructor(options: SessionLeechOptions) {
		this.dirs = normalizeDirs(options.dirs);
		this.intervalMs =
			typeof options.intervalMs === "number" && Number.isFinite(options.intervalMs) && options.intervalMs > 0
				? Math.max(250, options.intervalMs)
				: WATCH_INTERVAL_MS;
		this.maxAgeMs =
			typeof options.maxAgeMs === "number" && Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
				? options.maxAgeMs
				: DEFAULT_MAX_AGE_MS;
		this.replayLimit =
			typeof options.replayLimit === "number" && Number.isFinite(options.replayLimit)
				? Math.max(0, Math.floor(options.replayLimit))
				: DEFAULT_REPLAY_LIMIT;
		this.ignoreSession = options.ignoreSession;
		this.onEvent = options.onEvent;
	}

	get running(): boolean {
		return this.timer !== null;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.scanNow();
		}, this.intervalMs);
		this.timer.unref();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	addDirs(dirs: string[] = []): void {
		if (!Array.isArray(dirs)) return;
		for (const dir of dirs) {
			if (typeof dir !== "string" || !dir.trim()) continue;
			const resolved = resolve(dir);
			if (!this.dirs.includes(resolved)) this.dirs.push(resolved);
		}
	}

	/** Run one scan. Concurrent callers share the in-flight scan. */
	scanNow(): Promise<void> {
		if (this.scanPromise) return this.scanPromise;
		const run = this.runScan();
		this.scanPromise = run;
		return run;
	}

	getStatus(): LeechStatus {
		const status: LeechStatus = {
			enabled: true,
			running: this.running,
			dirs: [...this.dirs],
			files: this.files.size,
			sessions: this.sessionIds.size,
		};
		if (this.lastScanAt !== undefined) status.lastScanAt = this.lastScanAt;
		if (this.lastError !== undefined) status.lastError = this.lastError;
		return status;
	}

	private async runScan(): Promise<void> {
		try {
			await this.scan();
		} catch (error) {
			this.recordError(error, "leech scan");
		} finally {
			this.scanPromise = null;
		}
	}

	private async scan(): Promise<void> {
		const now = Date.now();
		const listing = await this.collectFiles(now);

		// Pre-pass: resolve every file's session header before emitting anything so
		// parentSession (an absolute file path) can be mapped to a session id.
		const headers = new Map<string, HeaderInfo>();
		const fileToSessionId = new Map<string, string>();
		for (const [filePath, fileStat] of listing) {
			const existing = this.files.get(filePath);
			let header = existing && existing.ino === fileStat.ino ? existing.header : null;
			if (!header) header = await readHeader(filePath);
			if (!header) continue;
			fileToSessionId.set(filePath, header.id);
			if (this.ignoreSession?.(header.id) === true) continue;
			headers.set(filePath, header);
		}

		for (const filePath of [...this.files.keys()]) {
			if (!headers.has(filePath)) this.files.delete(filePath);
		}
		this.sessionIds.clear();
		for (const id of fileToSessionId.values()) this.sessionIds.add(id);

		for (const [filePath, fileStat] of listing) {
			const header = headers.get(filePath);
			if (!header) continue;
			try {
				await this.consumeFile(filePath, fileStat, header, fileToSessionId);
			} catch (error) {
				this.recordError(error, `leech ${filePath}`);
			}
		}

		this.lastScanAt = Date.now();
	}

	private async collectFiles(now: number): Promise<Map<string, Stats>> {
		const files = new Map<string, Stats>();
		for (const dir of this.dirs) {
			await this.walk(dir, 0, now, files);
			if (files.size >= MAX_FILES) break;
		}
		return files;
	}

	private async walk(dir: string, depth: number, now: number, out: Map<string, Stats>): Promise<void> {
		if (out.size >= MAX_FILES) return;
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			this.recordError(error, `leech readdir ${dir}`);
			return;
		}
		for (const entry of entries) {
			if (out.size >= MAX_FILES) return;
			if (entry.isSymbolicLink()) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < MAX_SCAN_DEPTH) await this.walk(fullPath, depth + 1, now, out);
				continue;
			}
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) continue;
			try {
				const fileStat = await statFile(fullPath);
				if (!fileStat.isFile()) continue;
				if (now - fileStat.mtimeMs > this.maxAgeMs) continue;
				out.set(fullPath, fileStat);
			} catch {
				// Vanished or unreadable files are simply skipped.
			}
		}
	}

	private async consumeFile(
		filePath: string,
		fileStat: Stats,
		header: HeaderInfo,
		fileToSessionId: Map<string, string>,
	): Promise<void> {
		let state = this.files.get(filePath);
		if (!state || state.ino !== fileStat.ino) {
			state = {
				path: filePath,
				sessionId: header.id,
				header,
				ino: fileStat.ino,
				offset: 0,
				pendingBuffer: EMPTY_BUFFER,
				seenEntryIds: new Set(),
				mtimeMs: fileStat.mtimeMs,
				emittedStart: false,
				replaying: true,
				replayBuffer: [],
				model: "",
			};
			this.files.set(filePath, state);
		}

		if (fileStat.size < state.offset) await this.resetOnShrink(state);

		state.mtimeMs = fileStat.mtimeMs;
		state.parentSessionPath = state.header.parentSession;
		state.parentSessionId = state.parentSessionPath
			? (fileToSessionId.get(state.parentSessionPath) ?? fileToSessionId.get(resolve(state.parentSessionPath)))
			: undefined;

		await this.readChunk(filePath, fileStat, state);
		if (state.replaying) this.finishReplay(state);
	}

	private async resetOnShrink(state: FileState): Promise<void> {
		state.offset = 0;
		state.pendingBuffer = EMPTY_BUFFER;
		const header = await readHeader(state.path);
		if (!header) return;
		const sessionChanged = header.id !== state.sessionId;
		state.header = header;
		state.sessionId = header.id;
		state.parentSessionPath = header.parentSession;
		if (sessionChanged) {
			state.seenEntryIds.clear();
			state.emittedStart = false;
			state.replaying = true;
			state.replayBuffer = [];
			state.model = "";
		}
	}

	private async readChunk(filePath: string, fileStat: Stats, state: FileState): Promise<void> {
		const size = fileStat.size;
		let start = state.offset;
		let dropPartialLine = false;
		if (state.offset === 0 && state.pendingBuffer.length === 0 && size > MAX_FILE_BYTES) {
			start = size - MAX_FILE_BYTES;
			dropPartialLine = true;
		}
		if (size <= start) return;

		const length = size - start;
		const buffer = Buffer.allocUnsafe(length);
		let readTotal = 0;
		const handle = await open(filePath, "r");
		try {
			while (readTotal < length) {
				const { bytesRead } = await handle.read(buffer, readTotal, length - readTotal, start + readTotal);
				if (bytesRead <= 0) break;
				readTotal += bytesRead;
			}
		} finally {
			await handle.close().catch(() => {});
		}

		let chunk = buffer.subarray(0, readTotal);
		state.offset = size;
		if (chunk.length === 0) return;
		if (dropPartialLine) {
			const newline = chunk.indexOf(0x0a);
			chunk = newline === -1 ? EMPTY_BUFFER : chunk.subarray(newline + 1);
			if (chunk.length === 0) return;
		}

		const combined = state.pendingBuffer.length > 0 ? Buffer.concat([state.pendingBuffer, chunk]) : chunk;
		const lastNewline = combined.lastIndexOf(0x0a);
		if (lastNewline === -1) {
			state.pendingBuffer = Buffer.from(combined);
			return;
		}
		state.pendingBuffer = Buffer.from(combined.subarray(lastNewline + 1));
		this.consumeCompleteLines(state, combined.subarray(0, lastNewline));
	}

	private consumeCompleteLines(state: FileState, buffer: Buffer): void {
		let lineStart = 0;
		for (let index = 0; index <= buffer.length; index++) {
			if (index !== buffer.length && buffer[index] !== 0x0a) continue;
			if (index > lineStart) {
				const line = buffer.toString("utf8", lineStart, index).trim();
				if (line) this.consumeLine(state, line);
			}
			lineStart = index + 1;
		}
	}

	private consumeLine(state: FileState, line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.malformedLines += 1;
			this.setLastError(
				`Malformed JSON in ${state.path}: ${errorMessage(error)} (${this.malformedLines} malformed lines)`,
			);
			return;
		}
		const entry = asRecord(parsed);
		if (!entry) return;
		const type = str(entry.type);
		if (!type || type === "session") return;

		const entryId = str(entry.id);
		if (entryId) {
			if (state.seenEntryIds.has(entryId)) return;
			this.rememberEntryId(state, entryId);
		}

		const timestamp = parseTimestamp(str(entry.timestamp), state.mtimeMs);
		if (type === "message") {
			this.consumeMessageEntry(state, entry, timestamp);
		} else if (type === "model_change") {
			const model = modelLabel(str(entry.provider), str(entry.modelId));
			if (model) state.model = model;
			this.deliver(state, this.makeEvent(state, "session_meta", timestamp, { model }));
		} else if (type === "session_info") {
			const name = str(entry.name);
			if (name) this.deliver(state, this.makeEvent(state, "session_meta", timestamp, { title: name }));
		}
		// thinking_level_change, compaction, custom, label and unknown entries are ignored.
	}

	private consumeMessageEntry(state: FileState, entry: Record<string, unknown>, timestamp: number): void {
		const message = asRecord(entry.message);
		if (!message) return;
		const role = str(message.role);

		if (role === "user") {
			const text = truncate(contentText(message.content), MAX_PROMPT_CHARS);
			this.deliver(state, this.makeEvent(state, "user_prompt", timestamp, { text }));
			return;
		}

		if (role === "assistant") {
			const parts = assistantParts(message.content);
			const model = modelLabel(str(message.provider), str(message.model));
			if (model) state.model = model;
			this.deliver(
				state,
				this.makeEvent(state, "assistant_message", timestamp, {
					text: truncate(parts.text, MAX_MESSAGE_CHARS),
					thinking: truncate(parts.thinking, MAX_THINKING_CHARS),
					model,
				}),
			);
			if (str(message.stopReason) === "error") {
				this.deliver(
					state,
					this.makeEvent(state, "error", timestamp, {
						message: str(message.errorMessage, "assistant request failed"),
					}),
				);
			}
			for (const call of parts.toolCalls) {
				if (!call.id) continue;
				this.deliver(
					state,
					this.makeEvent(state, "tool_start", timestamp, {
						toolCallId: call.id,
						name: call.name,
						toolName: call.name,
						summary: toolHint(call.arguments),
					}),
				);
			}
			return;
		}

		if (role === "toolResult") {
			this.deliver(
				state,
				this.makeEvent(state, "tool_end", timestamp, {
					toolCallId: str(message.toolCallId),
					toolName: str(message.toolName),
					isError: bool(message.isError),
					durationMs: num(message.durationMs),
					summary: truncate(contentText(message.content), MAX_TOOL_RESULT_CHARS),
				}),
			);
		}
	}

	private rememberEntryId(state: FileState, entryId: string): void {
		if (state.seenEntryIds.size >= MAX_SEEN_ENTRY_IDS) {
			const oldest = state.seenEntryIds.values().next().value;
			if (oldest !== undefined) state.seenEntryIds.delete(oldest);
		}
		state.seenEntryIds.add(entryId);
	}

	private makeEvent(
		state: FileState,
		type: WebappEventType,
		timestamp: number,
		data: WebappEventData,
	): WebappEvent {
		return makeEvent({
			type,
			sessionId: state.sessionId,
			parentSessionId: state.parentSessionId,
			isSubagent: Boolean(state.parentSessionPath),
			source: "leech",
			timestamp,
			data,
		});
	}

	private deliver(state: FileState, event: WebappEvent): void {
		if (!state.replaying) {
			this.safeEmit(event);
			return;
		}
		if (this.replayLimit <= 0) return;
		if (state.replayBuffer.length >= this.replayLimit) state.replayBuffer.shift();
		state.replayBuffer.push(event);
	}

	private finishReplay(state: FileState): void {
		if (!state.emittedStart) this.emitSessionStarted(state);
		for (const event of state.replayBuffer) this.safeEmit(event);
		state.replayBuffer = [];
		state.replaying = false;
		state.emittedStart = true;
	}

	private emitSessionStarted(state: FileState): void {
		const timestamp = parseTimestamp(state.header.timestamp, state.mtimeMs);
		const data: WebappEventData = {
			cwd: state.header.cwd,
			title: sessionTitle(state.header.cwd, state.sessionId),
			model: state.model,
			sessionFile: state.path,
		};
		if (state.parentSessionId) data.parentSessionId = state.parentSessionId;
		this.safeEmit(
			makeEvent({
				type: "session_started",
				sessionId: state.sessionId,
				parentSessionId: state.parentSessionId,
				isSubagent: Boolean(state.parentSessionPath),
				source: "leech",
				timestamp,
				data,
			}),
		);
		state.emittedStart = true;
	}

	private safeEmit(event: WebappEvent): void {
		try {
			this.onEvent(event);
		} catch (error) {
			this.recordError(error, "leech onEvent");
		}
	}

	private recordError(error: unknown, context?: string): void {
		const detail = errorMessage(error);
		this.setLastError(context ? `${context}: ${detail}` : detail);
	}

	private setLastError(message: string): void {
		if (message !== this.lastError) this.lastError = message;
	}
}

function normalizeDirs(dirs: string[]): string[] {
	if (!Array.isArray(dirs)) return [];
	const out: string[] = [];
	for (const dir of dirs) {
		if (typeof dir !== "string" || !dir.trim()) continue;
		const resolved = resolve(dir);
		if (!out.includes(resolved)) out.push(resolved);
	}
	return out;
}
