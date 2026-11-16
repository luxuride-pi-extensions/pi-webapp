/**
 * Shared wire protocol between the pi extension, the dashboard server and the
 * Preact frontend. Keep this module dependency-free so it can be imported from
 * the browser bundle as well as from Node.
 */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const CACHE_DIR_NAME = "pi-webapp";
export const EVENT_HISTORY_LIMIT = 4000;
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
export const WATCH_INTERVAL_MS = 1500;
/** Environment variables understood by the extension and by child pi processes. */
export const ENV = {
    host: "PI_WEBAPP_HOST",
    port: "PI_WEBAPP_PORT",
    cacheDir: "PI_WEBAPP_CACHE_DIR",
    leech: "PI_WEBAPP_LEECH",
    leechDir: "PI_WEBAPP_LEECH_DIR",
    leechMaxAge: "PI_WEBAPP_LEECH_MAX_AGE_MS",
    playwright: "PI_WEBAPP_PLAYWRIGHT",
    stream: "PI_WEBAPP_STREAM",
    streamMs: "PI_WEBAPP_STREAM_MS",
    /** Set to 0 to forbid the dashboard from launching pi processes. */
    spawn: "PI_WEBAPP_SPAWN",
    /** Overrides the `pi` executable used for dashboard-spawned sessions. */
    piBin: "PI_WEBAPP_PI_BIN",
    /** Extra `--session-dir` for spawned sessions. */
    sessionDir: "PI_WEBAPP_SESSION_DIR",
    /** Identifies a session started by the dashboard (read by the child pi). */
    spawnId: "PI_WEBAPP_SPAWN_ID",
    /** Set to 0 to skip the systemd user service integration. */
    autostart: "PI_WEBAPP_AUTOSTART",
    /** Overrides the systemd unit name (tests use a throwaway unit). */
    systemdUnit: "PI_WEBAPP_SYSTEMD_UNIT",
    /** Propagated into child `pi` processes spawned as subagents. */
    parentSessionId: "PI_WEBAPP_PARENT_SESSION_ID",
    agentName: "PI_WEBAPP_AGENT_NAME",
    /** Common aliases used by out-of-process subagent launchers. */
    legacyParentSessionId: "PI_PARENT_SESSION_ID",
    legacyAgentName: "PI_SUBAGENT_NAME",
};
/** Tool names that delegate work to a subagent (out-of-process or in-process). */
export const SUBAGENT_TOOL_NAMES = [
    "subagent",
    "subagents",
    "Agent",
    "SubagentWorkflow",
    "Task",
    "spawn_agent",
    "spawn_subagent",
];
export function isSubagentToolName(name) {
    return SUBAGENT_TOOL_NAMES.includes(name);
}
export function makeEvent(input) {
    const event = {
        id: newId("evt"),
        type: input.type,
        sessionId: input.sessionId,
        timestamp: input.timestamp ?? Date.now(),
        data: input.data ?? {},
    };
    if (input.parentSessionId)
        event.parentSessionId = input.parentSessionId;
    if (input.agentName)
        event.agentName = input.agentName;
    if (input.isSubagent)
        event.isSubagent = true;
    if (input.source)
        event.source = input.source;
    return event;
}
export function newId(prefix = "id") {
    const bytes = new Uint8Array(8);
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.getRandomValues) {
        cryptoObj.getRandomValues(bytes);
    }
    else {
        for (let i = 0; i < bytes.length; i++)
            bytes[i] = Math.floor(Math.random() * 256);
    }
    return `${prefix}_${Date.now().toString(36)}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export function truncate(text, max) {
    if (text.length <= max)
        return text;
    if (max <= 3)
        return text.slice(0, max);
    return `${text.slice(0, max - 1)}…`;
}
/** Read a string field from an untyped event payload. */
export function str(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
export function num(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function bool(value, fallback = false) {
    return typeof value === "boolean" ? value : fallback;
}
export function mediaList(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== "object")
            continue;
        const record = item;
        const kind = record.kind === "video" ? "video" : record.kind === "image" ? "image" : null;
        const url = str(record.url);
        if (!kind || !url)
            continue;
        out.push({
            kind,
            url,
            filename: str(record.filename, url.split("/").pop() ?? "artifact"),
            bytes: num(record.bytes),
            mime: str(record.mime, kind === "video" ? "video/webm" : "image/png"),
        });
    }
    return out;
}
/** True when `candidate` resolves to `root` or something below it. */
export function isPathInside(root, candidate) {
    const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
    return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
//# sourceMappingURL=protocol.js.map