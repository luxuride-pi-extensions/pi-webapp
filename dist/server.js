/**
 * Dashboard HTTP + WebSocket server.
 *
 * The server is deliberately dependency-light: node:http serves the built web
 * assets, JSON APIs and artifacts, while `ws` carries live session updates and
 * prompt commands to/from pi instances.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_HOST, DEFAULT_PORT, ENV, EVENT_HISTORY_LIMIT, WATCH_INTERVAL_MS, isPathInside, newId, num, str, truncate, } from "./protocol.js";
import { SessionLeech } from "./leech.js";
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
const DEFAULT_LEECH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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
    leechError = null;
    localPromptHandler = null;
    spawner = null;
    initialPrompts = new Map();
    pendingSessionCommands = new Map();
    started = false;
    startedAt = 0;
    startInFlight = null;
    stopInFlight = null;
    heartbeatTimer = null;
    sessions = new Map();
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
            const maxAgeMs = leechOptions?.maxAgeMs && leechOptions.maxAgeMs > 0
                ? leechOptions.maxAgeMs
                : DEFAULT_LEECH_MAX_AGE_MS;
            try {
                leech = new SessionLeech({
                    dirs: this.leechDirs,
                    intervalMs,
                    maxAgeMs,
                    ignoreSession: (id) => this.sessions.get(id)?.source === "live",
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
        if (normalized.type === "session_started" && this.spawner) {
            const spawnId = str(normalized.data.spawnId);
            if (spawnId) {
                const spawn = this.spawner.get(spawnId);
                if (spawn) {
                    this.spawner.attachSession(spawnId, normalized.sessionId);
                    if (primary)
                        primary.spawnId = spawnId;
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
    /** Broadcasts spawn state to every connected browser. */
    notifySpawnChange(record) {
        const state = this.getSpawnState();
        if (record) {
            const fresh = state.spawns.find((item) => item.spawnId === record.spawnId) ?? record;
            this.broadcast({ type: "spawn", spawn: { ...fresh } });
        }
        this.broadcast({ type: "spawns", state });
    }
    getState() {
        const now = Date.now();
        const sessions = Array.from(this.sessions.values());
        let topLevel = 0;
        let subagents = 0;
        for (const node of sessions) {
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
                delete node.endedAt;
                node.updatedAt = Math.max(node.updatedAt, timestamp);
                touched.add(sessionId);
                break;
            }
            case "agent_end": {
                const node = this.ensureSession(sessionId, source, timestamp);
                node.status = "completed";
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
            if (pathname === "/api/events") {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handleEventsPost(req, res);
                return;
            }
            const promptMatch = /^\/api\/sessions\/([^/]+)\/prompt$/.exec(pathname);
            if (promptMatch) {
                if (method !== "POST")
                    return sendMethodNotAllowed(res, "POST");
                await this.handlePromptPost(req, res, promptMatch[1]);
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