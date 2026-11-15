/**
 * Session leech: tail pi session JSONL files on disk and turn newly appended
 * entries into WebappEvents. This lets the dashboard observe pi processes that
 * do not load the extension (and therefore never report live events).
 *
 * Live in-process events remain authoritative in the server; leeched events are
 * always marked with source "leech" so consumers can prefer live data.
 */
import { scanPiProcesses, scanPiSessionOwners, sessionIdFromSessionFile } from "./procs.js";
import { existsSync } from "node:fs";
import { open, readdir, stat as statFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { bool, makeEvent, num, str, truncate, WATCH_INTERVAL_MS, } from "./protocol.js";
/** A session file appears within seconds of its `pi` process starting. */
const OWNER_START_WINDOW_MS = 15_000;
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
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
const TOOL_HINT_KEYS = ["command", "file_path", "path", "pattern", "url", "prompt"];
function asRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
    return value;
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === "string")
        return error;
    try {
        return String(error);
    }
    catch {
        return "unknown error";
    }
}
function parseTimestamp(value, fallback) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0)
        return parsed;
    return fallback > 0 ? fallback : Date.now();
}
function sessionTitle(cwd, sessionId) {
    const short = sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
    const base = cwd ? basename(cwd) : "";
    if (!base || base === "." || base === "/")
        return short;
    return `${base} · ${short}`;
}
function modelLabel(provider, model) {
    if (provider && model)
        return `${provider}/${model}`;
    return model || provider;
}
function compactHint(text) {
    return text.replace(/\s+/g, " ").trim();
}
function toolHint(value) {
    const record = asRecord(value);
    if (record) {
        for (const key of TOOL_HINT_KEYS) {
            const candidate = record[key];
            if (typeof candidate !== "string")
                continue;
            const hint = compactHint(candidate);
            if (hint)
                return truncate(hint, MAX_TOOL_HINT_CHARS);
        }
        return "";
    }
    if (typeof value === "string") {
        const hint = compactHint(value);
        if (hint)
            return truncate(hint, MAX_TOOL_HINT_CHARS);
    }
    return "";
}
/** Join the text items of a message content value. */
function contentText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const item of content) {
        if (typeof item === "string") {
            parts.push(item);
            continue;
        }
        const record = asRecord(item);
        if (!record || record.type !== "text")
            continue;
        const text = str(record.text);
        if (text)
            parts.push(text);
    }
    return parts.join("\n");
}
function assistantParts(content) {
    const texts = [];
    const thinkings = [];
    const toolCalls = [];
    if (Array.isArray(content)) {
        for (const item of content) {
            const record = asRecord(item);
            if (!record)
                continue;
            if (record.type === "text") {
                const text = str(record.text);
                if (text)
                    texts.push(text);
            }
            else if (record.type === "thinking") {
                const thinking = str(record.thinking);
                if (thinking)
                    thinkings.push(thinking);
            }
            else if (record.type === "toolCall") {
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
async function readHeader(filePath) {
    try {
        const handle = await open(filePath, "r");
        try {
            const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
            if (bytesRead <= 0)
                return null;
            const text = buffer.subarray(0, bytesRead).toString("utf8");
            const newline = text.indexOf("\n");
            const line = (newline >= 0 ? text.slice(0, newline) : text).trim();
            if (!line)
                return null;
            const record = asRecord(JSON.parse(line));
            if (!record || record.type !== "session")
                return null;
            const id = str(record.id);
            if (!id)
                return null;
            const header = {
                id,
                cwd: str(record.cwd),
                timestamp: str(record.timestamp),
                version: num(record.version),
            };
            const parentSession = str(record.parentSession);
            if (parentSession)
                header.parentSession = parentSession;
            return header;
        }
        finally {
            await handle.close().catch(() => { });
        }
    }
    catch {
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
    dirs;
    intervalMs;
    maxAgeMs;
    replayLimit;
    ignoreSession;
    onSessionsRemoved;
    onEvent;
    files = new Map();
    sessionIds = new Set();
    timer = null;
    scanPromise = null;
    lastScanAt;
    lastError;
    malformedLines = 0;
    skippedStale = 0;
    ownersBySession = new Map();
    pendingBySession = new Map();
    constructor(options) {
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
        this.onSessionsRemoved = options.onSessionsRemoved;
        this.onEvent = options.onEvent;
    }
    get running() {
        return this.timer !== null;
    }
    /** Freshness window applied to session files that no live process owns. */
    get maxAge() {
        return this.maxAgeMs;
    }
    /**
     * Live-process view of a session: which `pi` pids own it, and whether the
     * transcript ends inside a turn (so killing the owner would lose work).
     */
    sessionRuntime(sessionId) {
        const pids = new Set(this.ownersBySession.get(sessionId) ?? []);
        const state = this.stateFor(sessionId);
        if (state) {
            for (const pid of this.processPidsFor(state))
                pids.add(pid);
        }
        return {
            pids: [...pids].sort((a, b) => a - b),
            pending: this.pendingBySession.get(sessionId) ?? false,
        };
    }
    stateFor(sessionId) {
        for (const state of this.files.values()) {
            if (state.sessionId === sessionId)
                return state;
        }
        return null;
    }
    /**
     * `pi` does not put its session id in its own environment, so a process
     * started outside this extension is matched by working directory and start
     * time instead: a session file is created when its process starts.
     */
    processPidsFor(state) {
        const cwd = state.header.cwd;
        const startedAt = Date.parse(state.header.timestamp);
        if (!cwd || !Number.isFinite(startedAt))
            return [];
        return scanPiProcesses()
            .filter((proc) => proc.cwd === cwd && Math.abs(proc.startedAt - startedAt) <= OWNER_START_WINDOW_MS)
            .map((proc) => proc.pid);
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            void this.scanNow();
        }, this.intervalMs);
        this.timer.unref();
    }
    stop() {
        if (!this.timer)
            return;
        clearInterval(this.timer);
        this.timer = null;
    }
    addDirs(dirs = []) {
        if (!Array.isArray(dirs))
            return;
        for (const dir of dirs) {
            if (typeof dir !== "string" || !dir.trim())
                continue;
            const resolved = resolve(dir);
            if (!this.dirs.includes(resolved))
                this.dirs.push(resolved);
        }
    }
    /** Run one scan. Concurrent callers share the in-flight scan. */
    scanNow() {
        if (this.scanPromise)
            return this.scanPromise;
        const run = this.runScan();
        this.scanPromise = run;
        return run;
    }
    getStatus() {
        const status = {
            enabled: true,
            running: this.running,
            dirs: [...this.dirs],
            files: this.files.size,
            sessions: this.sessionIds.size,
            skippedStale: this.skippedStale,
            maxAgeMs: this.maxAgeMs,
        };
        if (this.lastScanAt !== undefined)
            status.lastScanAt = this.lastScanAt;
        if (this.lastError !== undefined)
            status.lastError = this.lastError;
        return status;
    }
    async runScan() {
        try {
            await this.scan();
        }
        catch (error) {
            this.recordError(error, "leech scan");
        }
        finally {
            this.scanPromise = null;
        }
    }
    async scan() {
        const now = Date.now();
        // One /proc pass per scan: it decides both which stale files stay and
        // which running pi process owns a session (used by takeover).
        const owners = scanPiSessionOwners();
        this.ownersBySession = owners.pids;
        const { recent, stale } = await this.collectFiles(now);
        const listing = new Map(recent);
        let skipped = 0;
        for (const [filePath, fileStat] of stale) {
            const sessionId = sessionIdFromSessionFile(filePath) ?? this.files.get(filePath)?.sessionId ?? null;
            if (sessionId && owners.pids.has(sessionId))
                listing.set(filePath, fileStat);
            else
                skipped += 1;
        }
        this.skippedStale = skipped;
        // Pre-pass: resolve every file's session header before emitting anything so
        // parentSession (an absolute file path) can be mapped to a session id.
        const headers = new Map();
        const fileToSessionId = new Map();
        for (const [filePath, fileStat] of listing) {
            const existing = this.files.get(filePath);
            let header = existing && existing.ino === fileStat.ino ? existing.header : null;
            if (!header)
                header = await readHeader(filePath);
            if (!header)
                continue;
            fileToSessionId.set(filePath, header.id);
            if (this.ignoreSession?.(header.id) === true)
                continue;
            headers.set(filePath, header);
        }
        this.sessionIds.clear();
        for (const id of fileToSessionId.values())
            this.sessionIds.add(id);
        // Transcripts deleted on disk must disappear from the dashboard instead of
        // lingering until the next full reload.
        const vanished = [];
        for (const [filePath, state] of [...this.files.entries()]) {
            if (headers.has(filePath))
                continue;
            this.files.delete(filePath);
            if (!this.sessionIds.has(state.sessionId) && !existsSync(filePath))
                vanished.push(state.sessionId);
        }
        if (vanished.length > 0) {
            try {
                this.onSessionsRemoved?.([...new Set(vanished)]);
            }
            catch (error) {
                this.recordError(error, "leech removal");
            }
        }
        for (const [filePath, fileStat] of listing) {
            const header = headers.get(filePath);
            if (!header)
                continue;
            try {
                await this.consumeFile(filePath, fileStat, header, fileToSessionId);
            }
            catch (error) {
                this.recordError(error, `leech ${filePath}`);
            }
        }
        this.pendingBySession.clear();
        for (const state of this.files.values()) {
            if (state.pendingTurn !== undefined)
                this.pendingBySession.set(state.sessionId, state.pendingTurn);
        }
        this.lastScanAt = Date.now();
    }
    async collectFiles(now) {
        const files = { recent: new Map(), stale: new Map() };
        for (const dir of this.dirs) {
            await this.walk(dir, 0, now, files);
            if (files.recent.size + files.stale.size >= MAX_FILES)
                break;
        }
        return files;
    }
    async walk(dir, depth, now, out) {
        if (out.recent.size + out.stale.size >= MAX_FILES)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            this.recordError(error, `leech readdir ${dir}`);
            return;
        }
        for (const entry of entries) {
            if (out.recent.size + out.stale.size >= MAX_FILES)
                return;
            if (entry.isSymbolicLink())
                continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < MAX_SCAN_DEPTH)
                    await this.walk(fullPath, depth + 1, now, out);
                continue;
            }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl"))
                continue;
            try {
                const fileStat = await statFile(fullPath);
                if (!fileStat.isFile())
                    continue;
                if (now - fileStat.mtimeMs > this.maxAgeMs)
                    out.stale.set(fullPath, fileStat);
                else
                    out.recent.set(fullPath, fileStat);
            }
            catch {
                // Vanished or unreadable files are simply skipped.
            }
        }
    }
    async consumeFile(filePath, fileStat, header, fileToSessionId) {
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
        if (fileStat.size < state.offset)
            await this.resetOnShrink(state);
        state.mtimeMs = fileStat.mtimeMs;
        state.parentSessionPath = state.header.parentSession;
        state.parentSessionId = state.parentSessionPath
            ? (fileToSessionId.get(state.parentSessionPath) ?? fileToSessionId.get(resolve(state.parentSessionPath)))
            : undefined;
        await this.readChunk(filePath, fileStat, state);
        if (state.replaying)
            this.finishReplay(state);
    }
    async resetOnShrink(state) {
        state.offset = 0;
        state.pendingBuffer = EMPTY_BUFFER;
        const header = await readHeader(state.path);
        if (!header)
            return;
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
    async readChunk(filePath, fileStat, state) {
        const size = fileStat.size;
        let start = state.offset;
        let dropPartialLine = false;
        if (state.offset === 0 && state.pendingBuffer.length === 0 && size > MAX_FILE_BYTES) {
            start = size - MAX_FILE_BYTES;
            dropPartialLine = true;
        }
        if (size <= start)
            return;
        const length = size - start;
        const buffer = Buffer.allocUnsafe(length);
        let readTotal = 0;
        const handle = await open(filePath, "r");
        try {
            while (readTotal < length) {
                const { bytesRead } = await handle.read(buffer, readTotal, length - readTotal, start + readTotal);
                if (bytesRead <= 0)
                    break;
                readTotal += bytesRead;
            }
        }
        finally {
            await handle.close().catch(() => { });
        }
        let chunk = buffer.subarray(0, readTotal);
        state.offset = size;
        if (chunk.length === 0)
            return;
        if (dropPartialLine) {
            const newline = chunk.indexOf(0x0a);
            chunk = newline === -1 ? EMPTY_BUFFER : chunk.subarray(newline + 1);
            if (chunk.length === 0)
                return;
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
    consumeCompleteLines(state, buffer) {
        let lineStart = 0;
        for (let index = 0; index <= buffer.length; index++) {
            if (index !== buffer.length && buffer[index] !== 0x0a)
                continue;
            if (index > lineStart) {
                const line = buffer.toString("utf8", lineStart, index).trim();
                if (line)
                    this.consumeLine(state, line);
            }
            lineStart = index + 1;
        }
    }
    consumeLine(state, line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch (error) {
            this.malformedLines += 1;
            this.setLastError(`Malformed JSON in ${state.path}: ${errorMessage(error)} (${this.malformedLines} malformed lines)`);
            return;
        }
        const entry = asRecord(parsed);
        if (!entry)
            return;
        const type = str(entry.type);
        if (!type || type === "session")
            return;
        const entryId = str(entry.id);
        if (entryId) {
            if (state.seenEntryIds.has(entryId))
                return;
            this.rememberEntryId(state, entryId);
        }
        const timestamp = parseTimestamp(str(entry.timestamp), state.mtimeMs);
        if (type === "message") {
            this.consumeMessageEntry(state, entry, timestamp);
        }
        else if (type === "model_change") {
            const model = modelLabel(str(entry.provider), str(entry.modelId));
            if (model)
                state.model = model;
            this.deliver(state, this.makeEvent(state, "session_meta", timestamp, { model }));
        }
        else if (type === "session_info") {
            const name = str(entry.name);
            if (name)
                this.deliver(state, this.makeEvent(state, "session_meta", timestamp, { title: name }));
        }
        // thinking_level_change, compaction, custom, label and unknown entries are ignored.
    }
    consumeMessageEntry(state, entry, timestamp) {
        const message = asRecord(entry.message);
        if (!message)
            return;
        const role = str(message.role);
        if (role === "user") {
            state.pendingTurn = true;
            const text = truncate(contentText(message.content), MAX_PROMPT_CHARS);
            this.deliver(state, this.makeEvent(state, "user_prompt", timestamp, { text }));
            return;
        }
        if (role === "assistant") {
            const parts = assistantParts(message.content);
            // A finished assistant message without tool calls closes the turn;
            // tool calls mean the agent is still working.
            state.pendingTurn = parts.toolCalls.length > 0;
            const model = modelLabel(str(message.provider), str(message.model));
            if (model)
                state.model = model;
            this.deliver(state, this.makeEvent(state, "assistant_message", timestamp, {
                text: truncate(parts.text, MAX_MESSAGE_CHARS),
                thinking: truncate(parts.thinking, MAX_THINKING_CHARS),
                model,
            }));
            if (str(message.stopReason) === "error") {
                this.deliver(state, this.makeEvent(state, "error", timestamp, {
                    message: str(message.errorMessage, "assistant request failed"),
                }));
            }
            for (const call of parts.toolCalls) {
                if (!call.id)
                    continue;
                this.deliver(state, this.makeEvent(state, "tool_start", timestamp, {
                    toolCallId: call.id,
                    name: call.name,
                    toolName: call.name,
                    summary: toolHint(call.arguments),
                }));
            }
            return;
        }
        if (role === "toolResult") {
            state.pendingTurn = true;
            this.deliver(state, this.makeEvent(state, "tool_end", timestamp, {
                toolCallId: str(message.toolCallId),
                toolName: str(message.toolName),
                isError: bool(message.isError),
                durationMs: num(message.durationMs),
                summary: truncate(contentText(message.content), MAX_TOOL_RESULT_CHARS),
            }));
        }
    }
    rememberEntryId(state, entryId) {
        if (state.seenEntryIds.size >= MAX_SEEN_ENTRY_IDS) {
            const oldest = state.seenEntryIds.values().next().value;
            if (oldest !== undefined)
                state.seenEntryIds.delete(oldest);
        }
        state.seenEntryIds.add(entryId);
    }
    makeEvent(state, type, timestamp, data) {
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
    deliver(state, event) {
        if (!state.replaying) {
            this.safeEmit(event);
            return;
        }
        if (this.replayLimit <= 0)
            return;
        if (state.replayBuffer.length >= this.replayLimit)
            state.replayBuffer.shift();
        state.replayBuffer.push(event);
    }
    finishReplay(state) {
        if (!state.emittedStart)
            this.emitSessionStarted(state);
        for (const event of state.replayBuffer)
            this.safeEmit(event);
        state.replayBuffer = [];
        state.replaying = false;
        state.emittedStart = true;
    }
    emitSessionStarted(state) {
        const timestamp = parseTimestamp(state.header.timestamp, state.mtimeMs);
        const data = {
            cwd: state.header.cwd,
            title: sessionTitle(state.header.cwd, state.sessionId),
            model: state.model,
            sessionFile: state.path,
        };
        if (state.parentSessionId)
            data.parentSessionId = state.parentSessionId;
        this.safeEmit(makeEvent({
            type: "session_started",
            sessionId: state.sessionId,
            parentSessionId: state.parentSessionId,
            isSubagent: Boolean(state.parentSessionPath),
            source: "leech",
            timestamp,
            data,
        }));
        state.emittedStart = true;
    }
    safeEmit(event) {
        try {
            this.onEvent(event);
        }
        catch (error) {
            this.recordError(error, "leech onEvent");
        }
    }
    recordError(error, context) {
        const detail = errorMessage(error);
        this.setLastError(context ? `${context}: ${detail}` : detail);
    }
    setLastError(message) {
        if (message !== this.lastError)
            this.lastError = message;
    }
}
function normalizeDirs(dirs) {
    if (!Array.isArray(dirs))
        return [];
    const out = [];
    for (const dir of dirs) {
        if (typeof dir !== "string" || !dir.trim())
            continue;
        const resolved = resolve(dir);
        if (!out.includes(resolved))
            out.push(resolved);
    }
    return out;
}
//# sourceMappingURL=leech.js.map