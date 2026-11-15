/**
 * Dashboard HTTP + WebSocket server.
 *
 * The server is deliberately dependency-light: node:http serves the built web
 * assets, JSON APIs and artifacts, while `ws` carries live session updates and
 * prompt commands to/from pi instances.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_HOST, DEFAULT_PORT, ENV, EVENT_HISTORY_LIMIT, WATCH_INTERVAL_MS, isPathInside, newId, num, str, truncate, } from "./protocol.js";
import { SessionLeech } from "./leech.js";
import { PluginError, PluginRegistry } from "./plugins.js";
import { isPidAlive, killPid } from "./procs.js";
import { parseSpawnRequest } from "./spawn.js";
import { getCacheRoot, mimeForFile } from "./storage.js";
const MAX_API_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 100_000;
const STALE_LEECH_MS = 120_000;
/**
 * Grace period between an instance socket disappearing and its still-running
 * sessions being marked failed. A normal shutdown flushes `session_ended`
 * first, so waiting lets that event win the race against a socket close.
 */
const INSTANCE_DISCONNECT_GRACE_MS = 5_000;
const DEFAULT_LEECH_MAX_AGE_MS = 15 * 60 * 1000;
/**
 * How recently a session must have written for a running-but-idle owner to look
 * busy. `pendingTurn` from the transcript is the primary signal; this window
 * covers the gap between an event being written and the parser seeing it.
 */
const OWNER_BUSY_WINDOW_MS = 5_000;
/** How long a takeover waits for a stopped pi process to release its session. */
const MODEL_COMMAND_TIMEOUT_MS = 10_000;
const TAKEOVER_STOP_MS = 4_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const SNAPSHOT_GRACE_MS = 25;
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'none'";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");
const DEFAULT_WEB_ROOT = path.join(PACKAGE_ROOT, "dist", "web");
const STATIC_ASSETS = new Set(["/app.js", "/app.css", "/favicon.svg", "/favicon.ico"]);
const EVENT_TYPES = new Set([
    "session_started",
    "session_ended",
    "session_meta",
    "agent_start",
    "agent_end",
    "user_prompt",
    "assistant_message",
    "tool_start",
    "tool_end",
    "subagent_spawned",
    "subagent_completed",
    "work_state",
    "error",
]);
class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isWebappEventType(value) {
    return typeof value === "string" && EVENT_TYPES.has(value);
}
function isWebappEventLike(value) {
    return isRecord(value) && isWebappEventType(value.type) && typeof value.sessionId === "string";
}
function shortSessionId(id) {
    return id.length <= 8 ? id : id.slice(0, 8);
}
function normalizeStatus(value, fallback) {
    if (value === "running" || value === "completed" || value === "failed")
        return value;
    return fallback;
}
function normalizeDeliverAs(value) {
    if (value === "steer" || value === "followUp" || value === "auto")
        return value;
    return "auto";
}
function envLeechEnabled() {
    const value = process.env[ENV.leech];
    if (!value)
        return true;
    return !["0", "false", "off"].includes(value.trim().toLowerCase());
}
function normalizeLeechDirs(dirs) {
    const home = os.homedir();
    const out = [];
    for (const raw of dirs) {
        const trimmed = raw.trim();
        if (!trimmed)
            continue;
        const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? path.join(home, trimmed.slice(2)) : trimmed;
        out.push(expanded);
    }
    return out;
}
function applySecurityHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
}
function applyHtmlHeaders(res) {
    applySecurityHeaders(res);
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
}
function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
}
function sendText(res, status, text) {
    res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
}
function sendHtml(res, status, html, cacheControl) {
    applyHtmlHeaders(res);
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        "Cache-Control": cacheControl,
    });
    res.end(html);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function sendMethodNotAllowed(res, allow) {
    sendJson(res, 405, { ok: false, error: "method not allowed" }, { Allow: allow });
}
function readRequestBody(req, limit) {
    return new Promise((resolve, reject) => {
        const declaredLength = Number(req.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > limit) {
            req.resume();
            reject(new HttpError(413, "request body too large"));
            return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", (chunk) => {
            if (settled)
                return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(new HttpError(413, "request body too large"));
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (settled)
                return;
            settled = true;
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        req.on("error", (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        });
    });
}
async function readJsonBody(req, limit) {
    const text = await readRequestBody(req, limit);
    if (!text.trim())
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        throw new HttpError(400, "invalid JSON");
    }
}
function rawDataToString(data) {
    if (Array.isArray(data))
        return Buffer.concat(data).toString("utf8");
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString("utf8");
    return Buffer.from(data).toString("utf8");
}
function isSafeArtifactSegment(segment) {
    if (!segment)
        return false;
    if (segment === "." || segment === "..")
        return false;
    if (segment.includes("\0") || segment.includes("/") || segment.includes("\\"))
        return false;
    return true;
}
function parseRange(header, size) {
    if (!header)
        return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match)
        return "unsatisfiable";
    const startRaw = match[1] ?? "";
    const endRaw = match[2] ?? "";
    if (!startRaw && !endRaw)
        return "unsatisfiable";
    if (!startRaw) {
        const suffixLength = Number(endRaw);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0 || size === 0) {
            return "unsatisfiable";
        }
        return { start: Math.max(0, size - suffixLength), end: size - 1 };
    }
    const start = Number(startRaw);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size)
        return "unsatisfiable";
    let end = endRaw ? Number(endRaw) : size - 1;
    if (!Number.isSafeInteger(end) || end < start)
        return "unsatisfiable";
    if (end >= size)
        end = size - 1;
    return { start, end };
}
export class WebappServer {
    host;
    artifactsRoot;
    webRoot;
    configuredPort;
    listeningPort = 0;
    httpServer;
    wss;
    leech;
    leechEnabled;
    leechDirs;
    leechMaxAgeMs;
    ownerProbe;
    leechError = null;
    pluginRegistry = null;
    localPromptHandler = null;
    localModelHandler = null;
    models = [];
    modelAcks = new Map();
    spawner = null;
    initialPrompts = new Map();
    pendingSessionCommands = new Map();
    started = false;
    startedAt = 0;
    startInFlight = null;
    stopInFlight = null;
    heartbeatTimer = null;
    sessions = new Map();
    /** Sessions the operator removed; they stay hidden even if they keep talking. */
    removedSessions = new Set();
    sessionNames = new Map();
    events = [];
    owners = new Map();
    instanceSessions = new Map();
    commandQueues = new Map();
    clients = new Set();
    instanceClients = new Map();
    disconnectTimers = new Map();
    constructor(options = {}) {
        this.host = options.host?.trim() || DEFAULT_HOST;
        const requestedPort = options.port ?? DEFAULT_PORT;
        this.configuredPort =
            Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
                ? requestedPort
                : DEFAULT_PORT;
        this.webRoot = path.resolve(options.webRoot ?? DEFAULT_WEB_ROOT);
        this.artifactsRoot = path.resolve(options.artifactsRoot ?? getCacheRoot());
        this.ownerProbe = options.ownerProbe;
        const envMaxAge = Number(process.env[ENV.leechMaxAge] ?? "");
        const requestedMaxAge = options.leech && options.leech.maxAgeMs && options.leech.maxAgeMs > 0
            ? options.leech.maxAgeMs
            : Number.isFinite(envMaxAge) && envMaxAge > 0
                ? Math.floor(envMaxAge)
                : DEFAULT_LEECH_MAX_AGE_MS;
        this.leechMaxAgeMs = Math.max(30_000, requestedMaxAge);
        const leechOptions = options.leech === false ? null : options.leech;
        if (options.leech === false) {
            this.leechEnabled = false;
        }
        else if (options.leech?.enabled === false) {
            this.leechEnabled = false;
        }
        else if (options.leech?.enabled === true) {
            this.leechEnabled = true;
        }
        else {
            this.leechEnabled = envLeechEnabled();
        }
        const explicitDirs = leechOptions?.dirs;
        const envDirs = process.env[ENV.leechDir];
        const configuredDirs = explicitDirs && explicitDirs.length > 0
            ? explicitDirs
            : envDirs
                ? envDirs.split(path.delimiter)
                : [path.join(os.homedir(), ".pi", "agent", "sessions")];
        this.leechDirs = normalizeLeechDirs(configuredDirs);
        let leech = null;
        if (this.leechEnabled) {
            const intervalMs = leechOptions?.intervalMs && leechOptions.intervalMs > 0
                ? leechOptions.intervalMs
                : WATCH_INTERVAL_MS;
            const maxAgeMs = this.leechMaxAgeMs;
            try {
                leech = new SessionLeech({
                    dirs: this.leechDirs,
                    intervalMs,
                    maxAgeMs,
                    ignoreSession: (id) => this.sessions.get(id)?.source === "live",
                    onSessionsRemoved: (ids) => this.handleVanishedSessions(ids),
                    onEvent: (event) => this.ingest(event),
                });
            }
            catch (error) {
                this.leechError = `leech init failed: ${errorMessage(error)}`;
            }
        }
        this.leech = leech;
        this.httpServer = createServer((req, res) => {
            void this.route(req, res);
        });
        this.httpServer.on("upgrade", (req, socket, head) => {
            let pathname = "";
            try {
                pathname = new URL(req.url ?? "/", "http://localhost").pathname;
            }
            catch {
                pathname = "";
            }
            if (pathname !== "/ws") {
                socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(req, socket, head, (ws) => {
                this.wss.emit("connection", ws, req);
            });
        });
        this.wss = new WebSocketServer({ noServer: true });
        this.wss.on("connection", (ws, req) => {
            this.handleConnection(ws, req);
        });
    }
    get port() {
        return this.listeningPort || this.configuredPort;
    }
    get url() {
        const bracketedHost = this.host.includes(":") && !this.host.startsWith("[") ? `[${this.host}]` : this.host;
        return `http://${bracketedHost}:${this.port}`;
    }
    async start() {
        if (this.started)
            return this.port;
        if (this.startInFlight)
            return this.startInFlight;
        this.startInFlight = this.startInternal();
        try {
            return await this.startInFlight;
        }
        finally {
            this.startInFlight = null;
        }
    }
    async startInternal() {
        await mkdir(this.artifactsRoot, { recursive: true }).catch(() => undefined);
        await this.loadRemovedSessions();
        await this.loadSessionNames();
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                this.httpServer.off("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                this.httpServer.off("error", onError);
                resolve();
            };
            this.httpServer.once("error", onError);
            this.httpServer.once("listening", onListening);
            this.httpServer.listen({ host: this.host, port: this.configuredPort });
        });
        const address = this.httpServer.address();
        this.listeningPort =
            typeof address === "object" && address !== null ? address.port : this.configuredPort;
        this.started = true;
        this.startedAt = Date.now();
        this.startHeartbeat();
        await this.startLeech();
        return this.listeningPort;
    }
    async startLeech() {
        if (!this.leech || !this.leechEnabled)
            return;
        try {
            await this.leech.start();
            this.leechError = null;
        }
        catch (error) {
            this.leechError = `leech start failed: ${errorMessage(error)}`;
        }
    }
    async stop() {
        if (this.stopInFlight)
            return this.stopInFlight;
        const run = this.stopInternal();
        this.stopInFlight = run;
        try {
            await run;
        }
        finally {
            this.stopInFlight = null;
        }
    }
    async stopInternal() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const client of this.clients) {
            if (client.snapshotTimer) {
                clearTimeout(client.snapshotTimer);
                client.snapshotTimer = null;
            }
            try {
                client.ws.close(1001, "server stopping");
            }
            catch {
                // Ignore sockets that are already closing.
            }
            try {
                client.ws.terminate();
            }
            catch {
                // Ignore.
            }
        }
        this.clients.clear();
        this.instanceClients.clear();
        for (const timer of this.disconnectTimers.values())
            clearTimeout(timer);
        this.disconnectTimers.clear();
        this.owners.clear();
        this.instanceSessions.clear();
        this.commandQueues.clear();
        this.started = false;
        if (this.leech && this.leechEnabled) {
            try {
                await this.leech.stop();
            }
            catch (error) {
                this.leechError = `leech stop failed: ${errorMessage(error)}`;
            }
        }
        if (this.httpServer.listening) {
            await new Promise((resolve) => {
                this.httpServer.close(() => resolve());
                this.httpServer.closeAllConnections();
            });
        }
        this.listeningPort = 0;
    }
    ingest(event, instanceId) {
        if (!isWebappEventLike(event))
            return;
        const sessionId = event.sessionId.trim();
        if (!sessionId)
            return;
        if (this.removedSessions.has(sessionId))
            return;
        const source = event.source === "leech" ? "leech" : "live";
        const existing = this.sessions.get(sessionId);
        if (source === "leech" && existing?.source === "live")
            return;
        const normalized = {
            id: str(event.id) || newId("evt"),
            type: event.type,
            sessionId,
            timestamp: num(event.timestamp, Date.now()),
            data: isRecord(event.data) ? event.data : {},
        };
        if (str(event.parentSessionId))
            normalized.parentSessionId = str(event.parentSessionId);
        if (str(event.agentName))
            normalized.agentName = str(event.agentName);
        if (event.isSubagent === true)
            normalized.isSubagent = true;
        normalized.source = source;
        if (instanceId && source === "live") {
            this.assignOwner(sessionId, instanceId);
            this.cancelDisconnectTimer(sessionId);
            const childSessionId = str(normalized.data.childSessionId);
            if (childSessionId) {
                this.assignOwner(childSessionId, instanceId);
                this.cancelDisconnectTimer(childSessionId);
            }
        }
        const touched = this.applyEvent(normalized);
        const primary = this.sessions.get(normalized.sessionId);
        if (primary)
            primary.lastEventType = normalized.type;
        for (const id of touched) {
            const node = this.sessions.get(id);
            if (node)
                this.applyCustomName(node);
        }
        if (normalized.type === "session_started" && this.spawner) {
            const spawnId = str(normalized.data.spawnId);
            if (spawnId) {
                const spawn = this.spawner.get(spawnId);
                if (spawn) {
                    this.spawner.attachSession(spawnId, normalized.sessionId);
                    if (primary) {
                        primary.spawnId = spawnId;
                        delete primary.takeoverSpawnId;
                    }
                    this.notifySpawnChange({ ...spawn });
                    const prompt = this.initialPrompts.get(spawnId);
                    if (prompt) {
                        this.initialPrompts.delete(spawnId);
                        this.deliverCommand({
                            id: newId("cmd"),
                            sessionId: normalized.sessionId,
                            text: prompt,
                            deliverAs: "auto",
                            createdAt: Date.now(),
                        });
                    }
                }
            }
        }
        this.events.push(normalized);
        if (this.events.length > EVENT_HISTORY_LIMIT) {
            this.events.splice(0, this.events.length - EVENT_HISTORY_LIMIT);
        }
        for (const id of touched) {
            const session = this.sessions.get(id);
            if (session)
                this.broadcast({ type: "session", session: { ...session } });
        }
        this.broadcast({ type: "event", event: normalized });
    }
    setLocalPromptHandler(handler) {
        this.localPromptHandler = handler;
    }
    /** Local sessions can switch models through the owning extension instance. */
    setLocalModelHandler(handler) {
        this.localModelHandler = handler;
    }
    /** Models available to the attached pi instances, newest report wins. */
    setModels(models) {
        const next = [];
        const seen = new Set();
        for (const model of models) {
            const provider = str(model.provider);
            const id = str(model.id);
            if (!provider || !id)
                continue;
            const key = `${provider}/${id}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            const entry = { provider, id };
            const name = str(model.name);
            if (name)
                entry.name = name;
            next.push(entry);
        }
        this.models = next.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
        this.broadcast({ type: "models", models: this.models });
    }
    getModels() {
        return this.models.map((model) => ({ ...model }));
    }
    /** Installs the dashboard's process launcher (primary instances only). */
    setSessionSpawner(spawner) {
        this.spawner = spawner;
    }
    getSpawnState() {
        if (!this.spawner)
            return { enabled: false, spawns: [] };
        return {
            enabled: this.spawner.enabled,
            spawns: this.spawner.list(),
            defaultCwd: this.spawner.defaultWorkingDir,
        };
    }
    /**
     * Live-process view of a session: which pi pids own it and whether one of
     * them looks busy. Only leeched sessions need this — live ones are ours.
     */
    ownerInfo(node) {
        if (node.source === "live")
            return { pids: [], pending: false, busy: false };
        const leech = this.leech;
        const probe = this.ownerProbe ?? (leech ? (id) => leech.sessionRuntime(id) : null);
        let probeResult = null;
        if (probe) {
            try {
                probeResult = probe(node.id, node.sessionFile);
            }
            catch {
                probeResult = null;
            }
        }
        const pids = probeResult?.pids ?? [];
        const pending = probeResult?.pending ?? false;
        const recent = Number.isFinite(node.updatedAt) && Date.now() - node.updatedAt <= OWNER_BUSY_WINDOW_MS;
        // "Working" requires a live owner process: a transcript whose last entry is a
        // user message is not busy once the process that wrote it is gone.
        const busy = pids.length > 0 && (pending || recent);
        return { pids, pending, busy };
    }
    /**
     * Removes a session (and its subagents) from the dashboard. Running pi
     * processes started here are stopped first; transcripts are only unlinked
     * when explicitly requested.
     */
    async removeSession(sessionId, options = {}) {
        const node = this.sessions.get(sessionId);
        if (!node)
            throw new HttpError(404, "session not found");
        const targets = this.sessionFamily(sessionId);
        const spawner = this.spawner;
        if (spawner) {
            for (const id of targets) {
                const spawnId = this.sessions.get(id)?.spawnId;
                if (!spawnId)
                    continue;
                try {
                    await spawner.stop(spawnId);
                }
                catch {
                    /* the process is already gone */
                }
            }
        }
        let deletedFile;
        if (options.deleteFile) {
            for (const id of targets) {
                const file = this.sessions.get(id)?.sessionFile;
                if (!file || !file.endsWith(".jsonl"))
                    continue;
                try {
                    await unlink(file);
                    deletedFile = file;
                }
                catch {
                    /* missing file: nothing to delete */
                }
            }
        }
        const removed = this.dropSessions(targets);
        for (const id of removed)
            this.removedSessions.add(id);
        // Keep the tombstone list bounded.
        while (this.removedSessions.size > 500) {
            const oldest = this.removedSessions.values().next().value;
            if (typeof oldest !== "string")
                break;
            this.removedSessions.delete(oldest);
        }
        await this.persistRemovedSessions();
        if (removed.length > 0)
            this.broadcast({ type: "session_removed", sessionIds: removed });
        return { removed, deletedFile };
    }
    /** Transcripts deleted on disk disappear from the dashboard on the next scan. */
    handleVanishedSessions(sessionIds) {
        const leeched = sessionIds.filter((id) => this.sessions.get(id)?.source === "leech");
        if (leeched.length === 0)
            return;
        const removed = this.dropSessions(leeched);
        if (removed.length > 0)
            this.broadcast({ type: "session_removed", sessionIds: removed });
    }
    /** Ids of a session plus every subagent nested (transitively) under it. */
    sessionFamily(sessionId) {
        const family = new Set([sessionId]);
        let grew = true;
        while (grew) {
            grew = false;
            for (const candidate of this.sessions.values()) {
                if (family.has(candidate.id))
                    continue;
                if (candidate.parentSessionId && family.has(candidate.parentSessionId)) {
                    family.add(candidate.id);
                    grew = true;
                }
            }
        }
        return [...family];
    }
    /** Forgets the given sessions and their events without touching tombstones. */
    dropSessions(sessionIds) {
        const removed = [];
        for (const id of sessionIds) {
            if (!this.sessions.delete(id))
                continue;
            removed.push(id);
            this.owners.delete(id);
            this.pendingSessionCommands.delete(id);
            for (const ids of this.instanceSessions.values())
                ids.delete(id);
        }
        if (removed.length > 0) {
            const dropped = new Set(removed);
            for (let index = this.events.length - 1; index >= 0; index -= 1) {
                const event = this.events[index];
                if (event && dropped.has(event.sessionId))
                    this.events.splice(index, 1);
            }
        }
        return removed;
    }
    removedSessionsPath() {
        return path.join(this.artifactsRoot, ".removed-sessions.json");
    }
    sessionNamesPath() {
        return path.join(this.artifactsRoot, ".session-names.json");
    }
    /** Renames survive reloads and re-leeching, so they are kept on disk. */
    async loadSessionNames() {
        try {
            const raw = await readFile(this.sessionNamesPath(), "utf8");
            const parsed = JSON.parse(raw);
            if (!isRecord(parsed))
                return;
            for (const [id, value] of Object.entries(parsed)) {
                if (typeof value === "string" && value.trim())
                    this.sessionNames.set(id, value.trim());
            }
        }
        catch {
            /* no renames yet */
        }
    }
    async persistSessionNames() {
        try {
            const entries = [...this.sessionNames.entries()].slice(-1000);
            await writeFile(this.sessionNamesPath(), JSON.stringify(Object.fromEntries(entries)));
        }
        catch {
            /* renaming still works for this process */
        }
    }
    applyCustomName(node) {
        const name = this.sessionNames.get(node.id);
        if (name)
            node.customName = name;
        else
            delete node.customName;
    }
    /**
     * Sets (or clears, with an empty name) the dashboard label of a session.
     * The original agent name stays untouched so subagent roles remain visible.
     */
    async renameSession(sessionId, name) {
        const node = this.sessions.get(sessionId);
        if (!node)
            throw new HttpError(404, "session not found");
        const trimmed = truncate(name.trim().replace(/\s+/g, " "), 80);
        if (trimmed)
            this.sessionNames.set(sessionId, trimmed);
        else
            this.sessionNames.delete(sessionId);
        while (this.sessionNames.size > 1000) {
            const oldest = this.sessionNames.keys().next().value;
            if (typeof oldest !== "string")
                break;
            this.sessionNames.delete(oldest);
        }
        this.applyCustomName(node);
        await this.persistSessionNames();
        this.broadcast(trimmed
            ? { type: "session_renamed", sessionId, name: trimmed }
            : { type: "session_renamed", sessionId });
        this.broadcast({ type: "session", session: { ...node } });
        return { ...node };
    }
    async loadRemovedSessions() {
        try {
            const raw = await readFile(this.removedSessionsPath(), "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const value of parsed)
                    if (typeof value === "string")
                        this.removedSessions.add(value);
            }
        }
        catch {
            /* no tombstones yet */
        }
    }
    async persistRemovedSessions() {
        try {
            await writeFile(this.removedSessionsPath(), JSON.stringify([...this.removedSessions].slice(-500)));
        }
        catch {
            /* the dashboard still works without persistence */
        }
    }
    /** Broadcasts spawn state to every connected browser. */
    notifySpawnChange(record) {
        const state = this.getSpawnState();
        if (record) {
            const fresh = state.spawns.find((item) => item.spawnId === record.spawnId) ?? record;
            this.broadcast({ type: "spawn", spawn: { ...fresh } });
            if (fresh.status === "exited" || fresh.status === "failed")
                this.clearTakeover(fresh.spawnId);
        }
        this.broadcast({ type: "spawns", state });
    }
    /** Drops a pending takeover marker once its spawn is no longer in flight. */ clearTakeover(spawnId) {
        for (const node of this.sessions.values()) {
            if (this.removedSessions.has(node.id))
                continue;
            if (node.takeoverSpawnId !== spawnId)
                continue;
            delete node.takeoverSpawnId;
            this.broadcast({ type: "session", session: { ...node } });
        }
    }
    getState() {
        const now = Date.now();
        const sessions = Array.from(this.sessions.values());
        let topLevel = 0;
        let subagents = 0;
        for (const node of sessions) {
            this.applyCustomName(node);
            if (node.isSubagent) {
                subagents += 1;
            }
            else {
                topLevel += 1;
            }
            if (node.source === "leech" &&
                node.status === "running" &&
                now - node.updatedAt > STALE_LEECH_MS) {
                node.status = "completed";
                node.endedAt = node.endedAt ?? node.updatedAt;
            }
            if (node.source === "live") {
                node.busy = node.busy === true;
            }
            if (node.source === "leech") {
                const info = this.ownerInfo(node);
                if (info.pids.length > 0)
                    node.ownerPid = info.pids[0];
                else
                    delete node.ownerPid;
                if (info.busy)
                    node.ownerBusy = true;
                else
                    delete node.ownerBusy;
                // A leeched transcript has no attached instance of its own; whether it
                // is "working" is a property of the pi process that owns it, and it only
                // counts as live while such a process is actually running it.
                node.busy = info.busy;
                if (info.pids.length === 0) {
                    if (node.status === "running") {
                        node.status = "completed";
                        node.endedAt = node.endedAt ?? node.updatedAt;
                    }
                }
                else if (node.status !== "running") {
                    // A pi process is running this transcript, even if no instance of
                    // the extension inside it is attached to this dashboard.
                    node.status = "running";
                    delete node.endedAt;
                }
            }
            else {
                delete node.ownerPid;
                delete node.ownerBusy;
            }
        }
        sessions.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
        const events = this.events
            .slice()
            .sort((a, b) => a.timestamp - b.timestamp);
        return {
            sessions: sessions.map((node) => ({ ...node })),
            events,
            counts: { sessions: topLevel, subagents, events: events.length },
            leech: this.getLeechStatus(),
            spawn: this.getSpawnState(),
            models: this.getModels(),
            plugins: this.getPlugins().list(),
            serverTime: now,
        };
    }
    getLeechStatus() {
        if (!this.leechEnabled) {
            const status = {
                enabled: false,
                running: false,
                dirs: [],
                files: 0,
                sessions: 0,
                skippedStale: 0,
                maxAgeMs: this.leechMaxAgeMs,
            };
            if (this.leechError)
                status.lastError = this.leechError;
            return status;
        }
        if (!this.leech) {
            const status = {
                enabled: true,
                running: false,
                dirs: this.leechDirs,
                files: 0,
                sessions: 0,
                skippedStale: 0,
                maxAgeMs: this.leechMaxAgeMs,
            };
            if (this.leechError)
                status.lastError = this.leechError;
            return status;
        }
        try {
            const status = { ...this.leech.getStatus() };
            if (this.leechError)
                status.lastError = this.leechError;
            return status;
        }
        catch (error) {
            const status = {
                enabled: true,
                running: false,
                dirs: this.leechDirs,
                files: 0,
                sessions: 0,
                skippedStale: 0,
                maxAgeMs: this.leechMaxAgeMs,
                lastError: this.leechError ?? `leech status failed: ${errorMessage(error)}`,
            };
            return status;
        }
    }
    async rescanLeech(dirs) {
        if (!this.leech || !this.leechEnabled)
            return this.getLeechStatus();
        try {
            if (dirs && dirs.length > 0)
                this.leech.addDirs(normalizeLeechDirs(dirs));
            await this.leech.scanNow();
            this.leechError = null;
        }
        catch (error) {
            this.leechError = `leech scan failed: ${errorMessage(error)}`;
        }
        return this.getLeechStatus();
    }
    ensureSession(sessionId, source, timestamp) {
        let node = this.sessions.get(sessionId);
        if (!node) {
            node = {
                id: sessionId,
                status: "running",
                source,
                isSubagent: false,
                startedAt: timestamp,
                updatedAt: timestamp,
            };
            this.sessions.set(sessionId, node);
        }
        else if (source === "live" && node.source !== "live") {
            node.source = "live";
        }
        return node;
    }
    completedStub(sessionId, source, timestamp) {
        const stub = {
            id: sessionId,
            title: shortSessionId(sessionId),
            status: "completed",
            source,
            isSubagent: false,
            startedAt: timestamp,
            updatedAt: timestamp,
            endedAt: timestamp,
        };
        this.sessions.set(sessionId, stub);
        return stub;
    }
    applyEvent(event) {
        const touched = new Set();
        const data = event.data;
        const timestamp = event.timestamp;
        const sessionId = event.sessionId;
        const source = event.source ?? "live";
        switch (event.type) {
            case "session_started": {
                const node = this.ensureSession(sessionId, source, timestamp);
                const parentSessionId = event.parentSessionId || str(data.parentSessionId) || node.parentSessionId;
                const cwd = str(data.cwd) || node.cwd;
                const agentName = str(event.agentName) || str(data.agentName) || node.agentName;
                const title = str(data.title) ||
                    node.title ||
                    (cwd ? path.basename(cwd) : "") ||
                    shortSessionId(sessionId);
                if (parentSessionId)
                    node.parentSessionId = parentSessionId;
                if (cwd)
                    node.cwd = cwd;
                if (agentName)
                    node.agentName = agentName;
                node.title = title;
                const model = str(data.model);
                if (model)
                    node.model = model;
                const sessionFile = str(data.sessionFile);
                if (sessionFile)
                    node.sessionFile = sessionFile;
                const task = str(data.task);
                if (task)
                    node.task = task;
                node.source = source;
                node.isSubagent = Boolean(parentSessionId) || event.isSubagent === true || node.isSubagent;
                node.status = "running";
                node.busy = false;
                delete node.endedAt;
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
            case "session_meta": {
                const node = this.ensureSession(sessionId, source, timestamp);
                const title = str(data.title);
                if (title)
                    node.title = title;
                const cwd = str(data.cwd);
                if (cwd)
                    node.cwd = cwd;
                const model = str(data.model);
                if (model)
                    node.model = model;
                const agentName = str(data.agentName) || str(event.agentName);
                if (agentName)
                    node.agentName = agentName;
                const parentSessionId = str(data.parentSessionId) || str(event.parentSessionId);
                if (parentSessionId) {
                    node.parentSessionId = parentSessionId;
                    node.isSubagent = true;
                }
                const task = str(data.task);
                if (task)
                    node.task = task;
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
            case "session_ended": {
                const node = this.ensureSession(sessionId, source, timestamp);
                node.status = str(data.status) === "failed" ? "failed" : "completed";
                node.busy = false;
                node.endedAt = timestamp;
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
            case "subagent_spawned": {
                const parent = this.ensureSession(sessionId, source, timestamp);
                parent.updatedAt = Math.max(parent.updatedAt, timestamp);
                touched.add(sessionId);
                const childId = str(data.childSessionId);
                if (!childId || childId === sessionId)
                    break;
                const childSource = event.source ?? parent.source;
                const child = this.ensureSession(childId, childSource, timestamp);
                if (child.source !== "live")
                    child.source = childSource;
                child.parentSessionId = sessionId;
                child.agentName = str(event.agentName) || str(data.agentName) || child.agentName;
                child.task = str(data.task) || str(data.prompt) || str(data.description) || child.task;
                child.isSubagent = true;
                child.status = "running";
                child.title =
                    child.agentName && child.task
                        ? `${child.agentName}: ${truncate(child.task, 80)}`
                        : child.agentName || child.title || shortSessionId(childId);
                delete child.endedAt;
                child.updatedAt = Math.max(child.updatedAt, timestamp);
                touched.add(childId);
                break;
            }
            case "subagent_completed": {
                const childId = str(data.childSessionId) || sessionId;
                const child = this.ensureSession(childId, source, timestamp);
                const status = normalizeStatus(data.status, "completed");
                child.status = status;
                if (status !== "running")
                    child.endedAt = timestamp;
                child.updatedAt = Math.max(child.updatedAt, timestamp);
                touched.add(childId);
                const parentId = str(event.parentSessionId) ||
                    str(data.parentSessionId) ||
                    (childId !== sessionId ? sessionId : child.parentSessionId);
                if (parentId && parentId !== childId) {
                    const parent = this.sessions.get(parentId);
                    if (parent) {
                        parent.updatedAt = Math.max(parent.updatedAt, timestamp);
                    }
                    else {
                        this.completedStub(parentId, source, timestamp);
                    }
                    if (!child.parentSessionId)
                        child.parentSessionId = parentId;
                    touched.add(parentId);
                }
                break;
            }
            case "agent_start": {
                const node = this.ensureSession(sessionId, source, timestamp);
                node.status = "running";
                node.busy = true;
                delete node.endedAt;
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
            case "agent_end": {
                const node = this.ensureSession(sessionId, source, timestamp);
                // The turn is over, but a live session is still attached to its pi
                // instance: only the message stopped running, not the instance.
                if (node.source !== "live")
                    node.status = "completed";
                node.busy = false;
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
            case "user_prompt":
            case "assistant_message":
            case "tool_start":
            case "tool_end":
            case "work_state":
            case "error": {
                const node = this.ensureSession(sessionId, source, timestamp);
                // Trailing work events must not demote a live session that already
                // finished; a new turn revives it through agent_start/session_started.
                const terminalLive = node.source === "live" && (node.status === "completed" || node.status === "failed");
                if (!terminalLive) {
                    node.status = "running";
                    delete node.endedAt;
                }
                // Only a prompt, tool call or assistant message means the agent is
                // actually working; `work_state` can arrive after the turn ended.
                if (event.type === "user_prompt" || event.type === "tool_start" || event.type === "assistant_message") {
                    node.busy = !terminalLive ? true : node.busy === true;
                }
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
        }
        for (const id of Array.from(touched)) {
            const node = this.sessions.get(id);
            const parentSessionId = node?.parentSessionId;
            if (!node || !parentSessionId || this.sessions.has(parentSessionId))
                continue;
            this.completedStub(parentSessionId, node.source, timestamp);
            touched.add(parentSessionId);
        }
        return touched;
    }
    assignOwner(sessionId, instanceId) {
        const id = sessionId.trim();
        const owner = instanceId.trim();
        if (!id || !owner)
            return;
        this.owners.set(id, owner);
        let owned = this.instanceSessions.get(owner);
        if (!owned) {
            owned = new Set();
            this.instanceSessions.set(owner, owned);
        }
        owned.add(id);
        const pending = this.pendingSessionCommands.get(id);
        if (pending && pending.length > 0) {
            this.pendingSessionCommands.delete(id);
            for (const command of pending) {
                command.instanceId = owner;
                this.enqueueCommand(owner, command);
            }
        }
    }
    deliverCommand(command) {
        const owner = this.owners.get(command.sessionId);
        if (owner) {
            command.instanceId = owner;
            this.enqueueCommand(owner, command);
            return;
        }
        const pending = this.pendingSessionCommands.get(command.sessionId) ?? [];
        pending.push(command);
        this.pendingSessionCommands.set(command.sessionId, pending);
    }
    enqueueCommand(instanceId, command) {
        let queue = this.commandQueues.get(instanceId);
        if (!queue) {
            queue = [];
            this.commandQueues.set(instanceId, queue);
        }
        queue.push(command);
        this.flushCommands(instanceId);
    }
    flushCommands(instanceId) {
        const client = this.instanceClients.get(instanceId);
        if (!client || client.ws.readyState !== WebSocket.OPEN)
            return;
        const queue = this.commandQueues.get(instanceId);
        if (!queue || queue.length === 0)
            return;
        const remaining = [];
        for (const command of queue) {
            try {
                client.ws.send(JSON.stringify({ type: "command", command }));
            }
            catch {
                remaining.push(command);
            }
        }
        if (remaining.length > 0) {
            this.commandQueues.set(instanceId, remaining);
        }
        else {
            this.commandQueues.delete(instanceId);
        }
    }
    /** Sends a model switch to the owning instance and waits for its ack. */
    deliverModelCommand(command) {
        const owner = this.owners.get(command.sessionId);
        const client = owner ? this.instanceClients.get(owner) : undefined;
        if (!owner || !client || client.ws.readyState !== WebSocket.OPEN) {
            return Promise.resolve({ ok: false, error: "no pi instance is attached to this session" });
        }
        command.instanceId = owner;
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.modelAcks.delete(command.id);
                resolve({ ok: false, error: "the pi instance did not answer in time" });
            }, MODEL_COMMAND_TIMEOUT_MS);
            timeout.unref?.();
            this.modelAcks.set(command.id, (result) => {
                clearTimeout(timeout);
                resolve(result);
            });
            try {
                client.ws.send(JSON.stringify({ type: "model_command", command }));
            }
            catch {
                clearTimeout(timeout);
                this.modelAcks.delete(command.id);
                resolve({ ok: false, error: "the pi instance connection failed" });
            }
        });
    }
    async handleModelPost(req, res, encodedSessionId) {
        let sessionId;
        try {
            sessionId = decodeURIComponent(encodedSessionId);
        }
        catch {
            throw new HttpError(400, "invalid session id");
        }
        if (!sessionId)
            throw new HttpError(400, "invalid session id");
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        const record = isRecord(payload) ? payload : {};
        const provider = str(record.provider);
        const modelId = str(record.modelId) || str(record.id);
        if (!provider || !modelId) {
            throw new HttpError(400, "provider and modelId are required");
        }
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new HttpError(404, "session not found");
        if (session.source === "leech") {
            throw new HttpError(409, "session is leech-only: no pi instance is attached");
        }
        const command = {
            id: newId("model"),
            sessionId,
            provider,
            modelId,
            createdAt: Date.now(),
        };
        if (this.localModelHandler) {
            const local = await this.localModelHandler(command);
            if (local.ok) {
                sendJson(res, 200, { ok: true, delivered: "local" });
                return;
            }
            if (!this.owners.has(sessionId)) {
                sendJson(res, 409, { ok: false, error: local.error ?? "the model could not be applied" });
                return;
            }
        }
        const result = await this.deliverModelCommand(command);
        sendJson(res, result.ok ? 200 : 409, result.ok ? { ok: true, delivered: "instance" } : result);
    }
    getPlugins() {
        if (!this.pluginRegistry) {
            this.pluginRegistry = new PluginRegistry({
                statePath: path.join(this.artifactsRoot, ".plugins.json"),
            });
        }
        return this.pluginRegistry;
    }
    async handlePluginPost(req, res) {
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        try {
            const plugin = this.getPlugins().register(payload);
            this.broadcast({ type: "plugins", plugins: this.getPlugins().list() });
            sendJson(res, 201, { ok: true, plugin });
        }
        catch (error) {
            if (error instanceof PluginError)
                throw new HttpError(error.status, error.message);
            throw error;
        }
    }
    handlePluginAsset(res, pluginId, assetPath) {
        const file = this.getPlugins().assetPath(pluginId, assetPath);
        if (!file) {
            sendJson(res, 404, { ok: false, error: "plugin asset not found" });
            return;
        }
        void readFile(file).then((body) => {
            res.writeHead(200, {
                "content-type": mimeForFile(file),
                "content-length": String(body.byteLength),
                "cache-control": "no-cache",
                "x-content-type-options": "nosniff",
            });
            res.end(body);
        }, () => sendJson(res, 404, { ok: false, error: "plugin asset not found" }));
    }
    handleConnection(ws, req) {
        let queryRole = "";
        let queryInstanceId = "";
        try {
            const parsed = new URL(req.url ?? "/ws", "http://localhost");
            queryRole = parsed.searchParams.get("role") ?? "";
            queryInstanceId = (parsed.searchParams.get("instanceId") ?? "").trim();
        }
        catch {
            queryRole = "";
        }
        const client = {
            ws,
            role: "pending",
            instanceId: null,
            alive: true,
            snapshotSent: false,
            snapshotTimer: null,
        };
        this.clients.add(client);
        ws.on("pong", () => {
            client.alive = true;
        });
        ws.on("message", (data) => {
            client.alive = true;
            this.handleClientMessage(client, data);
        });
        ws.on("close", () => {
            this.handleClientClose(client);
        });
        ws.on("error", () => {
            try {
                ws.terminate();
            }
            catch {
                // Ignore.
            }
        });
        if (queryRole === "instance" && queryInstanceId) {
            this.registerInstance(client, queryInstanceId);
        }
        else if (queryRole === "ui") {
            client.role = "ui";
            this.sendSnapshot(client);
        }
        else {
            client.snapshotTimer = setTimeout(() => {
                client.snapshotTimer = null;
                if (client.role !== "pending")
                    return;
                client.role = "ui";
                this.sendSnapshot(client);
            }, SNAPSHOT_GRACE_MS);
            client.snapshotTimer.unref?.();
        }
    }
    handleClientMessage(client, data) {
        let parsed;
        try {
            parsed = JSON.parse(rawDataToString(data));
        }
        catch {
            return;
        }
        if (!isRecord(parsed))
            return;
        const type = typeof parsed.type === "string" ? parsed.type : "";
        if (type === "hello") {
            const message = parsed;
            if (message.role === "instance") {
                const instanceId = typeof message.instanceId === "string" && message.instanceId.trim()
                    ? message.instanceId.trim()
                    : newId("inst");
                this.registerInstance(client, instanceId);
                return;
            }
            if (client.role === "instance")
                return;
            if (client.snapshotTimer) {
                clearTimeout(client.snapshotTimer);
                client.snapshotTimer = null;
            }
            client.role = "ui";
            this.sendSnapshot(client);
            return;
        }
        if (type === "models") {
            const message = parsed;
            if (Array.isArray(message.models))
                this.setModels(message.models);
            return;
        }
        if (type === "model_command_ack") {
            const message = parsed;
            const pending = this.modelAcks.get(message.commandId);
            if (!pending)
                return;
            this.modelAcks.delete(message.commandId);
            pending({
                ok: message.ok === true,
                ...(message.error ? { error: message.error } : {}),
            });
            return;
        }
        if (type === "ping") {
            this.sendToClient(client, { type: "pong" });
        }
        // command_ack is informational; commands are removed from the queue when sent.
    }
    registerInstance(client, instanceId) {
        if (client.snapshotTimer) {
            clearTimeout(client.snapshotTimer);
            client.snapshotTimer = null;
        }
        client.role = "instance";
        client.instanceId = instanceId;
        this.instanceClients.set(instanceId, client);
        this.sendToClient(client, { type: "hello_ok", instanceId });
        this.flushCommands(instanceId);
    }
    handleClientClose(client) {
        if (client.snapshotTimer) {
            clearTimeout(client.snapshotTimer);
            client.snapshotTimer = null;
        }
        this.clients.delete(client);
        if (client.role !== "instance" || !client.instanceId)
            return;
        this.handleInstanceDisconnect(client);
    }
    handleInstanceDisconnect(client) {
        const instanceId = client.instanceId;
        if (!instanceId)
            return;
        if (this.instanceClients.get(instanceId) !== client)
            return;
        this.instanceClients.delete(instanceId);
        const owned = this.instanceSessions.get(instanceId);
        if (owned) {
            for (const sessionId of owned) {
                if (this.owners.get(sessionId) !== instanceId)
                    continue;
                this.owners.delete(sessionId);
                const node = this.sessions.get(sessionId);
                if (!node || node.source !== "live" || node.status !== "running")
                    continue;
                this.cancelDisconnectTimer(sessionId);
                const timer = setTimeout(() => {
                    this.disconnectTimers.delete(sessionId);
                    const current = this.sessions.get(sessionId);
                    if (!current || current.source !== "live" || current.status !== "running")
                        return;
                    const now = Date.now();
                    current.status = "failed";
                    current.endedAt = current.endedAt ?? now;
                    current.updatedAt = Math.max(current.updatedAt, now);
                    this.broadcast({ type: "session", session: { ...current } });
                }, INSTANCE_DISCONNECT_GRACE_MS);
                timer.unref?.();
                this.disconnectTimers.set(sessionId, timer);
            }
            this.instanceSessions.delete(instanceId);
        }
    }
    cancelDisconnectTimer(sessionId) {
        const timer = this.disconnectTimers.get(sessionId);
        if (!timer)
            return;
        clearTimeout(timer);
        this.disconnectTimers.delete(sessionId);
    }
    sendToClient(client, message) {
        if (message.type === "snapshot" && client.role === "instance")
            return false;
        if (client.ws.readyState !== WebSocket.OPEN)
            return false;
        try {
            client.ws.send(JSON.stringify(message));
            return true;
        }
        catch {
            return false;
        }
    }
    sendSnapshot(client) {
        if (client.role === "instance")
            return;
        if (this.sendToClient(client, { type: "snapshot", state: this.getState() })) {
            client.snapshotSent = true;
        }
    }
    broadcast(message) {
        const payload = JSON.stringify(message);
        for (const client of this.clients) {
            if (client.role !== "ui" || !client.snapshotSent)
                continue;
            if (client.ws.readyState !== WebSocket.OPEN)
                continue;
            try {
                client.ws.send(payload);
            }
            catch {
                // A broken browser connection is cleaned up by its close handler.
            }
        }
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            return;
        this.heartbeatTimer = setInterval(() => {
            for (const client of this.clients) {
                if (!client.alive) {
                    try {
                        client.ws.terminate();
                    }
                    catch {
                        // Ignore.
                    }
                    continue;
                }
                client.alive = false;
                try {
                    client.ws.ping();
                }
                catch {
                    try {
                        client.ws.terminate();
                    }
                    catch {
                        // Ignore.
                    }
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeatTimer.unref?.();
    }
    async route(req, res) {
        applySecurityHeaders(res);
        const method = (req.method ?? "GET").toUpperCase();
        let url;
        try {
            url = new URL(req.url ?? "/", "http://localhost");
        }
        catch {
            sendText(res, 400, "bad request");
            return;
        }
        const pathname = url.pathname;
        if (method === "OPTIONS" && (pathname === "/api" || pathname.startsWith("/api/"))) {
            res.writeHead(204);
            res.end();
            return;
        }
        try {
            if (pathname.startsWith("/artifacts/")) {
                await this.handleArtifact(req, res, method, pathname);
                return;
            }
            if (pathname === "/api/state") {
                if (method !== "GET")
                    return sendMethodNotAllowed(res, "GET");
                sendJson(res, 200, this.getState());
                return;
            }
            if (pathname === "/api/health") {
                if (method !== "GET")
                    return sendMethodNotAllowed(res, "GET");
                sendJson(res, 200, {
                    ok: true,
                    uptimeMs: this.started ? Date.now() - this.startedAt : 0,
                    sessions: this.sessions.size,
                });
                return;
            }
            if (pathname === "/api/plugins") {
                if (method === "GET") {
                    sendJson(res, 200, { plugins: this.getPlugins().list() });
                    return;
                }
                if (method === "POST") {
                    await this.handlePluginPost(req, res);
                    return;
                }
                return sendMethodNotAllowed(res, "GET, POST");
            }
            const pluginItemMatch = /^\/api\/plugins\/([^/]+)$/.exec(pathname);
            if (pluginItemMatch) {
                if (method !== "DELETE")
                    return sendMethodNotAllowed(res, "DELETE");
                const id = decodeURIComponent(pluginItemMatch[1] ?? "");
                const removed = this.getPlugins().remove(id);
                if (!removed)
                    throw new HttpError(404, "plugin not found");
                this.broadcast({ type: "plugins", plugins: this.getPlugins().list() });
                sendJson(res, 200, { ok: true });
                return;
            }
            if (pathname.startsWith("/plugins/")) {
                if (method !== "GET" && method !== "HEAD")
                    return sendMethodNotAllowed(res, "GET, HEAD");
                const rest = pathname.slice("/plugins/".length);
                const slash = rest.indexOf("/");
                if (slash <= 0)
                    return sendJson(res, 404, { ok: false, error: "plugin asset not found" });
                this.handlePluginAsset(res, rest.slice(0, slash), rest.slice(slash + 1));
                return;
            }
            if (pathname === "/api/events") {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handleEventsPost(req, res);
                return;
            }
            const modelMatch = /^\/api\/sessions\/([^/]+)\/model$/.exec(pathname);
            if (modelMatch) {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handleModelPost(req, res, modelMatch[1]);
                return;
            }
            const promptMatch = /^\/api\/sessions\/([^/]+)\/prompt$/.exec(pathname);
            if (promptMatch) {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handlePromptPost(req, res, promptMatch[1]);
                return;
            }
            const renameMatch = /^\/api\/sessions\/([^/]+)\/rename$/.exec(pathname);
            if (renameMatch) {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handleRenameSession(req, res, renameMatch[1]);
                return;
            }
            const removeMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
            if (removeMatch) {
                if (method !== "DELETE")
                    return sendMethodNotAllowed(res, "DELETE");
                await this.handleRemoveSession(req, res, removeMatch[1]);
                return;
            }
            const takeoverMatch = /^\/api\/sessions\/([^/]+)\/takeover$/.exec(pathname);
            if (takeoverMatch) {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handleTakeoverPost(req, res, takeoverMatch[1]);
                return;
            }
            if (pathname === "/api/spawn") {
                if (method === "GET") {
                    sendJson(res, 200, this.getSpawnState());
                    return;
                }
                if (method === "POST") {
                    await this.handleSpawnPost(req, res);
                    return;
                }
                return sendMethodNotAllowed(res, "GET, POST");
            }
            const spawnMatch = /^\/api\/spawn\/([^/]+)(\/log)?$/.exec(pathname);
            if (spawnMatch) {
                await this.handleSpawnItem(res, method, spawnMatch[1], Boolean(spawnMatch[2]));
                return;
            }
            if (pathname === "/api/leech") {
                if (method !== "GET")
                    return sendMethodNotAllowed(res, "GET");
                sendJson(res, 200, this.getLeechStatus());
                return;
            }
            if (pathname === "/api/leech/scan") {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handleLeechScanPost(req, res);
                return;
            }
            if (pathname === "/" || pathname === "/index.html") {
                if (method !== "GET" && method !== "HEAD")
                    return sendMethodNotAllowed(res, "GET, HEAD");
                await this.serveIndex(res, method);
                return;
            }
            if (STATIC_ASSETS.has(pathname)) {
                if (method !== "GET" && method !== "HEAD")
                    return sendMethodNotAllowed(res, "GET, HEAD");
                await this.serveStaticAsset(res, method, pathname);
                return;
            }
            if (pathname.startsWith("/api/")) {
                sendJson(res, 404, { ok: false, error: "not found" });
            }
            else {
                sendText(res, 404, "not found");
            }
        }
        catch (error) {
            if (error instanceof HttpError) {
                sendJson(res, error.status, { ok: false, error: error.message });
                return;
            }
            if (!res.headersSent) {
                sendJson(res, 500, { ok: false, error: "internal server error" });
            }
            else {
                res.destroy();
            }
        }
    }
    async handleRemoveSession(req, res, encodedSessionId) {
        let sessionId;
        try {
            sessionId = decodeURIComponent(encodedSessionId);
        }
        catch {
            throw new HttpError(400, "invalid session id");
        }
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        const deleteFile = isRecord(payload) && payload.deleteFile === true;
        const result = await this.removeSession(sessionId, { deleteFile });
        sendJson(res, 200, { ok: true, ...result });
    }
    async handleRenameSession(req, res, encodedSessionId) {
        let sessionId;
        try {
            sessionId = decodeURIComponent(encodedSessionId);
        }
        catch {
            throw new HttpError(400, "invalid session id");
        }
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        const raw = isRecord(payload) ? payload.name : undefined;
        if (raw !== undefined && raw !== null && typeof raw !== "string") {
            throw new HttpError(400, "name must be a string");
        }
        const session = await this.renameSession(sessionId, typeof raw === "string" ? raw : "");
        sendJson(res, 200, { ok: true, session });
    }
    async handleEventsPost(req, res) {
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        if (payload === undefined) {
            throw new HttpError(400, "invalid JSON");
        }
        let accepted = false;
        if (isWebappEventLike(payload)) {
            this.ingest(payload);
            accepted = true;
        }
        else if (isRecord(payload)) {
            const instanceId = str(payload.instanceId).trim() || undefined;
            if (isWebappEventLike(payload.event)) {
                this.ingest(payload.event, instanceId);
                accepted = true;
            }
            if (Array.isArray(payload.events)) {
                for (const event of payload.events) {
                    if (!isWebappEventLike(event))
                        continue;
                    this.ingest(event, instanceId);
                    accepted = true;
                }
            }
        }
        if (!accepted)
            throw new HttpError(400, "no Webapp events in request body");
        sendJson(res, 200, { ok: true });
    }
    async handleSpawnPost(req, res) {
        if (!this.spawner || !this.spawner.enabled) {
            throw new HttpError(403, "spawning is disabled on this instance (only the primary dashboard on a loopback address can start pi sessions)");
        }
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        let request;
        try {
            request = parseSpawnRequest(payload, this.spawner.defaultWorkingDir);
        }
        catch (error) {
            const status = isRecord(error) && typeof error.status === "number" ? error.status : 400;
            throw new HttpError(status, errorMessage(error));
        }
        let record;
        try {
            record = await this.spawner.spawn(request);
        }
        catch (error) {
            const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
            throw new HttpError(status, errorMessage(error));
        }
        if (request.prompt) {
            // The child registers itself as an instance; steers arrive over WS.
            this.initialPrompts.set(record.spawnId, request.prompt);
        }
        this.notifySpawnChange(record);
        sendJson(res, 201, { ok: true, spawn: record });
    }
    /**
     * Resumes a leeched session in a fresh pi process so it becomes live and can
     * be prompted. Refused for subagents, live sessions and busy owners; when an
     * idle pi process still holds the session, callers must opt in to stopping
     * it with `{ kill: true }` before the takeover proceeds.
     */
    async handleTakeoverPost(req, res, encodedSessionId) {
        let sessionId;
        try {
            sessionId = decodeURIComponent(encodedSessionId);
        }
        catch {
            throw new HttpError(400, "invalid session id");
        }
        if (!sessionId)
            throw new HttpError(400, "invalid session id");
        const node = this.sessions.get(sessionId);
        if (!node) {
            sendJson(res, 404, { ok: false, error: "session not found" });
            return;
        }
        if (node.source === "live") {
            sendJson(res, 409, { ok: false, code: "live", error: "session is already live" });
            return;
        }
        if (node.isSubagent) {
            sendJson(res, 409, {
                ok: false,
                code: "subagent",
                error: "subagent sessions cannot be taken over",
            });
            return;
        }
        const spawner = this.spawner;
        if (!spawner || !spawner.enabled) {
            sendJson(res, 403, {
                ok: false,
                error: "spawning is not available on this dashboard",
            });
            return;
        }
        if (!node.sessionFile) {
            sendJson(res, 400, {
                ok: false,
                error: "session file is unknown, so this session cannot be resumed",
            });
            return;
        }
        if (node.takeoverSpawnId) {
            const inFlight = spawner.get(node.takeoverSpawnId);
            if (inFlight && (inFlight.status === "starting" || inFlight.status === "running")) {
                sendJson(res, 409, {
                    ok: false,
                    code: "takeover-pending",
                    error: "a takeover is already starting for this session",
                });
                return;
            }
        }
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        const body = isRecord(payload) ? payload : {};
        if (body.prompt !== undefined && typeof body.prompt !== "string") {
            throw new HttpError(400, "prompt must be a string");
        }
        const prompt = typeof body.prompt === "string" && body.prompt.length > 0
            ? body.prompt.slice(0, MAX_PROMPT_LENGTH)
            : undefined;
        let killedPid;
        const owner = this.ownerInfo(node);
        if (owner.pids.length > 0) {
            const pid = owner.pids[0];
            if (owner.busy) {
                sendJson(res, 409, {
                    ok: false,
                    code: "owner-busy",
                    pid,
                    error: `session is busy in pi pid ${pid}; wait for the current turn to finish`,
                });
                return;
            }
            if (body.kill !== true) {
                sendJson(res, 409, {
                    ok: false,
                    code: "owner-running",
                    pid,
                    canKill: true,
                    error: `session is still open in pi pid ${pid}`,
                });
                return;
            }
            // Re-check immediately before signalling: the owner may have changed.
            const confirmed = this.ownerInfo(node);
            if (!confirmed.pids.includes(pid)) {
                sendJson(res, 409, {
                    ok: false,
                    code: "owner-changed",
                    error: "the owning pi process changed; refresh and try again",
                });
                return;
            }
            killPid(pid, "SIGTERM");
            const deadline = Date.now() + TAKEOVER_STOP_MS;
            while (Date.now() < deadline && isPidAlive(pid))
                await sleep(100);
            if (isPidAlive(pid)) {
                killPid(pid, "SIGKILL");
                const hardDeadline = Date.now() + 1_500;
                while (Date.now() < hardDeadline && isPidAlive(pid))
                    await sleep(100);
            }
            if (isPidAlive(pid)) {
                sendJson(res, 409, {
                    ok: false,
                    code: "owner-stuck",
                    pid,
                    error: `could not stop pi pid ${pid}`,
                });
                return;
            }
            killedPid = pid;
        }
        let record;
        try {
            record = await spawner.spawn({
                cwd: node.cwd ?? spawner.defaultWorkingDir ?? process.cwd(),
                sessionFile: node.sessionFile,
                targetSessionId: node.id,
                prompt,
            });
        }
        catch (error) {
            const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
            throw new HttpError(status, errorMessage(error));
        }
        if (killedPid !== undefined)
            record.killedPid = killedPid;
        node.takeoverSpawnId = record.spawnId;
        this.notifySpawnChange({ ...record });
        this.broadcast({ type: "session", session: { ...node } });
        sendJson(res, 202, { ok: true, spawn: record, killedPid });
    }
    async handleSpawnItem(res, method, encodedSpawnId, wantLog) {
        let spawnId;
        try {
            spawnId = decodeURIComponent(encodedSpawnId);
        }
        catch {
            throw new HttpError(400, "invalid spawn id");
        }
        if (wantLog) {
            if (method !== "GET")
                return sendMethodNotAllowed(res, "GET");
            const tail = this.spawner?.logTail(spawnId) ?? null;
            if (tail === null)
                throw new HttpError(404, "spawn not found");
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
            res.end(tail);
            return;
        }
        if (method !== "DELETE")
            return sendMethodNotAllowed(res, "DELETE");
        if (!this.spawner)
            throw new HttpError(404, "spawn not found");
        if (!this.spawner.stop(spawnId)) {
            const record = this.spawner.get(spawnId);
            if (!record)
                throw new HttpError(404, "spawn not found");
            throw new HttpError(409, `spawn is not running (${record.status})`);
        }
        this.notifySpawnChange(this.spawner.get(spawnId) ?? undefined);
        sendJson(res, 200, { ok: true });
    }
    async handlePromptPost(req, res, encodedSessionId) {
        let sessionId;
        try {
            sessionId = decodeURIComponent(encodedSessionId);
        }
        catch {
            throw new HttpError(400, "invalid session id");
        }
        if (!sessionId)
            throw new HttpError(400, "invalid session id");
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        const record = isRecord(payload) ? payload : {};
        const text = typeof record.text === "string" ? record.text : "";
        if (text.length === 0 || text.length > MAX_PROMPT_LENGTH) {
            throw new HttpError(400, `text must be between 1 and ${MAX_PROMPT_LENGTH} characters`);
        }
        const command = {
            id: newId("cmd"),
            sessionId,
            text,
            deliverAs: normalizeDeliverAs(record.deliverAs),
            createdAt: Date.now(),
        };
        if (this.localPromptHandler) {
            const handled = await this.localPromptHandler(command);
            if (handled) {
                sendJson(res, 200, { ok: true, delivered: "local" });
                return;
            }
        }
        const owner = this.owners.get(sessionId);
        if (owner) {
            command.instanceId = owner;
            this.enqueueCommand(owner, command);
            sendJson(res, 202, { ok: true, delivered: "instance" });
            return;
        }
        const session = this.sessions.get(sessionId);
        if (session?.source === "leech") {
            // A transcript nobody is running can simply be resumed: prompting it
            // starts a fresh pi process, no takeover ceremony required.
            const resumed = await this.promptLeachedSession(res, session, text);
            if (resumed)
                return;
            sendJson(res, 409, {
                ok: false,
                error: "session is leech-only: no pi instance is attached",
            });
            return;
        }
        if (session) {
            // The instance has not claimed the session yet (spawn in flight).
            this.deliverCommand(command);
            sendJson(res, 202, { ok: true, delivered: "instance" });
            return;
        }
        sendJson(res, 404, { ok: false, error: "session not found" });
    }
    /** Resumes an idle leeched session so a dashboard prompt can reach it. */
    async promptLeachedSession(res, node, text) {
        const spawner = this.spawner;
        if (!spawner || !spawner.enabled)
            return false;
        if (node.isSubagent) {
            sendJson(res, 409, {
                ok: false,
                code: "subagent",
                error: "subagent sessions cannot be resumed from the dashboard",
            });
            return true;
        }
        const owner = this.ownerInfo(node);
        if (owner.pids.length > 0) {
            const pid = owner.pids[0];
            sendJson(res, 409, {
                ok: false,
                code: owner.busy ? "owner-busy" : "owner-running",
                pid,
                canKill: !owner.busy,
                error: owner.busy
                    ? `session is busy in pi pid ${pid}; wait for the current turn to finish`
                    : `session is open in pi pid ${pid}; take it over to prompt from here`,
            });
            return true;
        }
        if (!node.sessionFile) {
            sendJson(res, 400, {
                ok: false,
                error: "session file is unknown, so this session cannot be resumed",
            });
            return true;
        }
        let record;
        try {
            record = await spawner.spawn({
                cwd: node.cwd ?? spawner.defaultWorkingDir ?? process.cwd(),
                sessionFile: node.sessionFile,
                targetSessionId: node.id,
                prompt: text,
            });
        }
        catch (error) {
            const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
            throw new HttpError(status, errorMessage(error));
        }
        this.initialPrompts.set(record.spawnId, text);
        node.takeoverSpawnId = record.spawnId;
        this.notifySpawnChange({ ...record });
        this.broadcast({ type: "session", session: { ...node } });
        sendJson(res, 202, { ok: true, delivered: "spawned", spawn: record });
        return true;
    }
    async handleLeechScanPost(req, res) {
        const payload = await readJsonBody(req, MAX_API_BODY_BYTES);
        let dirs;
        if (isRecord(payload) && Array.isArray(payload.dirs)) {
            dirs = payload.dirs
                .filter((value) => typeof value === "string" && value.trim().length > 0)
                .map((value) => value.trim());
        }
        sendJson(res, 200, await this.rescanLeech(dirs));
    }
    async serveIndex(res, method) {
        const indexPath = path.join(this.webRoot, "index.html");
        let html = null;
        try {
            html = await readFile(indexPath, "utf8");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        if (html === null) {
            const diagnostic = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>pi-webapp</title></head><body><main><h1>pi-webapp</h1><p>pi-webapp is not built yet. Run: npm run build</p></main></body></html>`;
            if (method === "HEAD") {
                applyHtmlHeaders(res);
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Content-Length": Buffer.byteLength(diagnostic),
                    "Cache-Control": "no-cache",
                });
                res.end();
                return;
            }
            sendHtml(res, 200, diagnostic, "no-cache");
            return;
        }
        if (method === "HEAD") {
            applyHtmlHeaders(res);
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": Buffer.byteLength(html),
                "Cache-Control": "no-cache",
            });
            res.end();
            return;
        }
        sendHtml(res, 200, html, "no-cache");
    }
    async serveStaticAsset(res, method, pathname) {
        const assetPath = path.resolve(this.webRoot, pathname.replace(/^\//, ""));
        if (!isPathInside(this.webRoot, assetPath)) {
            sendText(res, 404, "not found");
            return;
        }
        let content;
        try {
            content = await readFile(assetPath);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                sendText(res, 404, "not found");
                return;
            }
            throw error;
        }
        res.writeHead(200, {
            "Content-Type": mimeForFile(assetPath),
            "Content-Length": content.byteLength,
            "Cache-Control": "public, max-age=60",
        });
        if (method === "HEAD") {
            res.end();
            return;
        }
        res.end(content);
    }
    async handleArtifact(req, res, method, pathname) {
        if (method !== "GET" && method !== "HEAD") {
            sendMethodNotAllowed(res, "GET, HEAD");
            return;
        }
        const rawPath = pathname.slice("/artifacts/".length);
        const rawSegments = rawPath.split("/");
        if (rawSegments.length !== 2) {
            sendJson(res, 400, { ok: false, error: "invalid artifact path" });
            return;
        }
        let sessionId;
        let filename;
        try {
            sessionId = decodeURIComponent(rawSegments[0] ?? "");
            filename = decodeURIComponent(rawSegments[1] ?? "");
        }
        catch {
            sendJson(res, 400, { ok: false, error: "invalid artifact path" });
            return;
        }
        if (!isSafeArtifactSegment(sessionId) || !isSafeArtifactSegment(filename)) {
            sendJson(res, 400, { ok: false, error: "invalid artifact path" });
            return;
        }
        const root = path.resolve(this.artifactsRoot);
        const artifactPath = path.resolve(root, sessionId, filename);
        if (!isPathInside(root, artifactPath)) {
            sendJson(res, 400, { ok: false, error: "invalid artifact path" });
            return;
        }
        let info;
        try {
            info = await stat(artifactPath);
        }
        catch (error) {
            const code = error.code;
            sendJson(res, code === "ENOENT" ? 404 : 500, {
                ok: false,
                error: code === "ENOENT" ? "artifact not found" : "could not read artifact",
            });
            return;
        }
        if (!info.isFile()) {
            sendJson(res, 404, { ok: false, error: "artifact not found" });
            return;
        }
        const size = info.size;
        const safeFilename = filename.replace(/["\\\r\n]/g, "_");
        const commonHeaders = {
            "Content-Type": mimeForFile(filename),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=300",
            "Content-Disposition": `inline; filename="${safeFilename}"`,
        };
        const range = parseRange(req.headers.range, size);
        if (range === "unsatisfiable") {
            res.writeHead(416, {
                ...commonHeaders,
                "Content-Range": `bytes */${size}`,
                "Content-Length": 0,
            });
            res.end();
            return;
        }
        if (range) {
            const length = range.end - range.start + 1;
            res.writeHead(206, {
                ...commonHeaders,
                "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
                "Content-Length": length,
            });
            if (method === "HEAD") {
                res.end();
                return;
            }
            this.streamArtifact(artifactPath, res, { start: range.start, end: range.end });
            return;
        }
        res.writeHead(200, { ...commonHeaders, "Content-Length": size });
        if (method === "HEAD") {
            res.end();
            return;
        }
        this.streamArtifact(artifactPath, res);
    }
    streamArtifact(filePath, res, options = {}) {
        const stream = createReadStream(filePath, options);
        stream.on("error", (error) => {
            const code = error.code;
            if (!res.headersSent) {
                sendJson(res, code === "ENOENT" ? 404 : 500, {
                    ok: false,
                    error: code === "ENOENT" ? "artifact not found" : "could not read artifact",
                });
                return;
            }
            res.destroy();
        });
        stream.pipe(res);
    }
}
//# sourceMappingURL=server.js.map