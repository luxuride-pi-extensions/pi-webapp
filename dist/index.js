import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.js";
import { daemonStatus, startDetachedDaemon, stopDetachedDaemon } from "./daemonctl.js";
import { DEFAULT_HOST, DEFAULT_PORT, ENV, isSubagentToolName, makeEvent, newId, str, truncate, } from "./protocol.js";
import { createCapturePlaywrightTool, createPostWorkStateTool } from "./tools.js";
import { describeSystemdService, ensureAutostartService, installSystemdService, uninstallSystemdService, } from "./systemd.js";
/** Repository/package root; used to describe the extension and to spawn siblings. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADER_READ_BYTES = 64 * 1024;
const USER_TEXT_LIMIT = 8000;
const ASSISTANT_TEXT_LIMIT = 8000;
const THINKING_LIMIT = 2000;
const TOOL_HINT_LIMIT = 200;
const TOOL_SUMMARY_LIMIT = 1500;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value) {
    return isRecord(value) ? value : null;
}
function firstString(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0)
            return value;
    }
    return undefined;
}
function extractText(content, max) {
    if (typeof content === "string")
        return truncate(content, max);
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const item of content) {
        if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
            parts.push(item.text);
        }
    }
    return truncate(parts.join("\n"), max);
}
function extractThinking(content, max) {
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const item of content) {
        if (isRecord(item) && item.type === "thinking" && typeof item.thinking === "string") {
            parts.push(item.thinking);
        }
    }
    return truncate(parts.join("\n"), max);
}
function summarizeArgs(args) {
    const preferred = [
        "command",
        "cmd",
        "path",
        "file",
        "pattern",
        "query",
        "url",
        "description",
        "task",
        "prompt",
        "title",
    ];
    const hint = firstString(args, preferred);
    if (hint)
        return truncate(hint, TOOL_HINT_LIMIT);
    try {
        return truncate(JSON.stringify(args), TOOL_HINT_LIMIT);
    }
    catch {
        return "";
    }
}
function summarizeResult(result) {
    const record = asRecord(result);
    if (record) {
        const text = extractText(record.content, TOOL_SUMMARY_LIMIT);
        if (text)
            return text;
    }
    if (typeof result === "string")
        return truncate(result, TOOL_SUMMARY_LIMIT);
    try {
        return truncate(JSON.stringify(result), TOOL_SUMMARY_LIMIT);
    }
    catch {
        return "";
    }
}
function readSpawnSpec(value) {
    if (typeof value === "string")
        return { agentName: "subagent", task: value };
    const record = asRecord(value);
    if (!record)
        return { agentName: "subagent", task: "" };
    return {
        agentName: firstString(record, ["agent", "name"]) ?? "subagent",
        task: firstString(record, ["task", "prompt"]) ?? "",
    };
}
function deriveSpawns(args) {
    if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        return args.tasks.map(readSpawnSpec);
    }
    if (Array.isArray(args.chain) && args.chain.length > 0) {
        return args.chain.map(readSpawnSpec);
    }
    return [
        {
            agentName: firstString(args, ["agent", "name"]) ?? "subagent",
            task: firstString(args, ["task", "prompt", "description"]) ?? "",
        },
    ];
}
function restoreEnvValue(key, value) {
    if (value === undefined) {
        delete process.env[key];
    }
    else {
        process.env[key] = value;
    }
}
async function resolveParentSessionId(parentSession) {
    const configured = process.env[ENV.parentSessionId] || process.env[ENV.legacyParentSessionId];
    if (configured)
        return configured;
    if (!parentSession)
        return undefined;
    let fallback = path.basename(parentSession);
    if (fallback.toLowerCase().endsWith(".jsonl"))
        fallback = fallback.slice(0, -6);
    try {
        const handle = await open(parentSession, "r");
        try {
            const buffer = Buffer.alloc(HEADER_READ_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const text = buffer.subarray(0, bytesRead).toString("utf8");
            const headerLine = text.split("\n").find((line) => line.trim().length > 0);
            if (headerLine) {
                const parsed = JSON.parse(headerLine);
                if (isRecord(parsed) && typeof parsed.id === "string" && parsed.id) {
                    return parsed.id;
                }
            }
        }
        finally {
            await handle.close();
        }
    }
    catch {
        // Fall back to the session file name below.
    }
    return fallback || undefined;
}
export default function piWebapp(pi) {
    const instanceId = `${process.pid}-${newId("pi")}`;
    let bridge = null;
    let bridgePromise = null;
    let bridgeErrorNotified = false;
    let shuttingDown = false;
    let ctxRef = null;
    let session = null;
    const spawnChildren = new Map();
    const envStack = new Map();
    function notify(message, type = "info") {
        try {
            ctxRef?.ui.notify(message, type);
        }
        catch {
            // notifications are advisory
        }
    }
    function emit(event) {
        const current = bridge;
        if (!current)
            return;
        try {
            current.emit(event);
        }
        catch {
            // the dashboard must never break a turn
        }
    }
    function currentEvent(type, data) {
        const active = session;
        if (!active)
            return null;
        return makeEvent({
            type,
            sessionId: active.sessionId,
            parentSessionId: active.parentSessionId,
            agentName: active.agentName,
            isSubagent: active.isSubagent,
            data,
        });
    }
    function deliverPrompt(command) {
        const active = session;
        if (!active || command.sessionId !== active.sessionId)
            return false;
        try {
            if (active.busy || command.deliverAs === "steer") {
                pi.sendUserMessage(command.text, { deliverAs: "steer" });
            }
            else if (command.deliverAs === "followUp") {
                pi.sendUserMessage(command.text, { deliverAs: "followUp" });
            }
            else {
                pi.sendUserMessage(command.text);
            }
            return true;
        }
        catch {
            return false;
        }
    }
    let autostartNotified = false;
    async function ensureBridge() {
        if (bridge)
            return;
        if (!bridgePromise) {
            bridgePromise = (async () => {
                try {
                    const host = process.env[ENV.host] || DEFAULT_HOST;
                    const port = Number(process.env[ENV.port]) || DEFAULT_PORT;
                    const created = await createBridge({
                        instanceId,
                        host,
                        port,
                        spawn: { rootDir: PACKAGE_ROOT },
                    });
                    created.setPromptHandler(deliverPrompt);
                    created.setModelHandler(handleModelCommand);
                    bridge = created;
                    return created;
                }
                catch (error) {
                    bridgePromise = null;
                    if (!bridgeErrorNotified) {
                        bridgeErrorNotified = true;
                        const message = error instanceof Error ? error.message : String(error);
                        notify(`pi-webapp: could not start the dashboard bridge: ${message}`, "error");
                    }
                    return null;
                }
            })();
        }
        await bridgePromise;
    }
    /** Every model this instance could switch to (authenticated providers only). */
    function availableModels() {
        const ctx = ctxRef;
        if (!ctx)
            return [];
        return ctx.modelRegistry.getAvailable().map((model) => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
        }));
    }
    function publishModels() {
        try {
            bridge?.publishModels(availableModels());
        }
        catch {
            // model reporting is a convenience, never a session blocker
        }
    }
    /** Applies a model switch requested from the dashboard. */
    async function handleModelCommand(command) {
        const ctx = ctxRef;
        if (!ctx)
            return { ok: false, error: "pi is not ready yet" };
        const active = session;
        if (!active || active.sessionId !== command.sessionId) {
            return { ok: false, error: "this session is owned by another pi instance" };
        }
        const model = ctx.modelRegistry.find(command.provider, command.modelId);
        if (!model)
            return { ok: false, error: `unknown model ${command.provider}/${command.modelId}` };
        try {
            const applied = await pi.setModel(model);
            if (!applied) {
                return {
                    ok: false,
                    error: `${command.provider}/${command.modelId} has no configured credentials`,
                };
            }
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        emit(makeEvent({
            type: "session_meta",
            sessionId: command.sessionId,
            parentSessionId: active.parentSessionId,
            agentName: active.agentName,
            isSubagent: active.isSubagent,
            data: { model: `${command.provider}/${command.modelId}` },
        }));
        return { ok: true };
    }
    /** Makes sure the always-on systemd dashboard exists before we decide to host one ourselves. */
    async function prepareAutostart() {
        try {
            const host = process.env[ENV.host]?.trim() || DEFAULT_HOST;
            const port = Number(process.env[ENV.port]) || DEFAULT_PORT;
            const result = await ensureAutostartService({ host, port, start: true, waitMs: 5_000 });
            if (!result.installed || !result.changed || autostartNotified)
                return;
            autostartNotified = true;
            notify([
                `pi-webapp: dashboard autostart enabled (${result.unitPath})`,
                `It starts at login and keeps running after pi exits: ${result.url}`,
                'Opt out with "/webapp daemon uninstall"; logs: journalctl --user -u pi-webapp -f',
            ].join("\n"), "info");
        }
        catch {
            // autostart is a convenience; a failure must not block the session
        }
    }
    function restoreEnv(toolCallId) {
        const saved = envStack.get(toolCallId);
        if (!saved)
            return;
        envStack.delete(toolCallId);
        restoreEnvValue(ENV.parentSessionId, saved.parent);
        restoreEnvValue(ENV.agentName, saved.name);
    }
    function getToolRuntime() {
        const active = session;
        if (!active)
            throw new Error("pi-webapp: no active pi session.");
        return {
            sessionId: active.sessionId,
            parentSessionId: active.parentSessionId,
            agentName: active.agentName,
            isSubagent: active.isSubagent,
            cwd: active.cwd,
            getBridge: () => bridge,
            emit,
        };
    }
    pi.registerTool(createPostWorkStateTool(getToolRuntime));
    pi.registerTool(createCapturePlaywrightTool(getToolRuntime));
    const handleDaemonCommand = async (action, portArg) => {
        const verb = action && action.length > 0 ? action : "start";
        const requestedPort = portArg && /^\d+$/.test(portArg) ? Number(portArg) : undefined;
        try {
            if (verb === "install") {
                const result = await installSystemdService({
                    ...(requestedPort === undefined ? {} : { port: requestedPort }),
                    start: true,
                });
                notify([
                    `pi-webapp: systemd user service ${result.changed ? "installed" : "refreshed"}: ${result.unitPath}`,
                    `It starts at login and keeps the dashboard running after pi exits: ${result.url}`,
                    result.detail ?? "",
                    "Logs: journalctl --user -u pi-webapp -f",
                    'Remove it again with "/webapp daemon uninstall".',
                ]
                    .filter(Boolean)
                    .join("\n"), "info");
                return;
            }
            if (verb === "uninstall") {
                const result = uninstallSystemdService();
                notify([
                    result.removed
                        ? `pi-webapp: removed ${result.unitPath}`
                        : `pi-webapp: no systemd unit at ${result.unitPath}`,
                    "Autostart stays disabled until you run /webapp daemon install again.",
                ].join("\n"), "info");
                return;
            }
            if (verb === "start") {
                const result = await startDetachedDaemon(requestedPort === undefined ? {} : { port: requestedPort });
                notify(result.alreadyRunning
                    ? `pi-webapp dashboard is already running: ${result.url}`
                    : `pi-webapp dashboard started in the background: ${result.url}${result.pid ? ` (pid ${result.pid})` : ""}`, "info");
                return;
            }
            if (verb === "stop") {
                const result = await stopDetachedDaemon();
                notify(`pi-webapp dashboard stopped${result.pid ? ` (pid ${result.pid})` : ""}${result.detail ? `: ${result.detail}` : ""}`, "info");
                return;
            }
            if (verb === "status") {
                const status = await daemonStatus();
                notify([
                    `pi-webapp daemon: ${status.running ? "running" : "not running"}`,
                    `URL: ${status.url}`,
                    status.pid ? `PID: ${status.pid}` : "PID: (not managed by pi-webapp)",
                    status.detail ?? "",
                    describeSystemdService(),
                ]
                    .filter(Boolean)
                    .join("\n"), "info");
                return;
            }
            notify("Usage: /webapp [status] | /webapp daemon [start [port]|stop|status|install|uninstall]", "warning");
        }
        catch (error) {
            notify(`pi-webapp: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
    };
    pi.registerCommand("webapp", {
        description: "Show the pi-webapp dashboard URL/mode, or manage the standalone daemon",
        handler: async (args, ctx) => {
            ctxRef = ctx;
            const words = (args ?? "").trim().split(/\s+/);
            const sub = words[0]?.toLowerCase() ?? "";
            if (sub === "daemon" || sub === "start" || sub === "stop" || sub === "status") {
                await handleDaemonCommand(sub === "daemon" ? words[1] : sub, sub === "daemon" || sub === "start" ? words[2] : undefined);
                return;
            }
            await ensureBridge();
            const activeBridge = bridge;
            if (!activeBridge) {
                notify("pi-webapp: the dashboard bridge is not available.", "error");
                return;
            }
            let leech = null;
            let leechError;
            try {
                leech = await activeBridge.getLeechStatus();
            }
            catch (error) {
                leechError = error instanceof Error ? error.message : String(error);
            }
            const lines = [
                "pi-webapp dashboard",
                `URL: ${activeBridge.url}`,
                `Mode: ${activeBridge.mode}`,
            ];
            if (leech) {
                lines.push(`Leech: ${leech.enabled ? "enabled" : "disabled"}${leech.running ? ", running" : ""}`, `Sessions: ${leech.sessions} · Files: ${leech.files}`);
                if (leech.dirs.length > 0)
                    lines.push(`Dirs: ${leech.dirs.join(", ")}`);
                if (leech.lastError)
                    lines.push(`Last error: ${leech.lastError}`);
            }
            else {
                lines.push(`Leech: unavailable${leechError ? ` (${leechError})` : ""}`);
            }
            notify(lines.join("\n"), "info");
        },
    });
    pi.on("session_start", async (_event, ctx) => {
        try {
            ctxRef = ctx;
            const sessionId = ctx.sessionManager.getSessionId();
            const header = ctx.sessionManager.getHeader();
            const sessionFile = ctx.sessionManager.getSessionFile();
            const parentSessionId = await resolveParentSessionId(header?.parentSession);
            const cwd = header?.cwd ?? ctx.cwd;
            const sessionName = pi.getSessionName();
            const agentName = process.env[ENV.agentName] ||
                process.env[ENV.legacyAgentName] ||
                sessionName;
            session = {
                sessionId,
                parentSessionId,
                agentName,
                cwd,
                isSubagent: Boolean(parentSessionId),
                busy: false,
            };
            await prepareAutostart();
            await ensureBridge();
            publishModels();
            const title = str(sessionName, path.basename(cwd) || cwd);
            const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
            emit(makeEvent({
                type: "session_started",
                sessionId,
                parentSessionId,
                agentName,
                isSubagent: Boolean(parentSessionId),
                data: {
                    title,
                    cwd,
                    model,
                    sessionFile,
                    parentSessionId,
                    agentName,
                    isSubagent: Boolean(parentSessionId),
                    spawnId: process.env[ENV.spawnId]?.trim() || undefined,
                },
            }));
        }
        catch {
            // a dashboard failure must not prevent a session from starting
        }
    });
    pi.on("message_end", (event) => {
        try {
            const active = session;
            if (!active)
                return;
            const message = event.message;
            if (!message || typeof message !== "object")
                return;
            if (message.role === "user") {
                const text = extractText(message.content, USER_TEXT_LIMIT);
                if (!text)
                    return;
                const userEvent = currentEvent("user_prompt", { text });
                if (userEvent)
                    emit(userEvent);
                return;
            }
            if (message.role === "assistant") {
                const text = extractText(message.content, ASSISTANT_TEXT_LIMIT);
                const thinking = extractThinking(message.content, THINKING_LIMIT);
                if (!text && !thinking)
                    return;
                const assistantEvent = currentEvent("assistant_message", {
                    text,
                    thinking,
                    model: `${message.provider}/${message.model}`,
                });
                if (assistantEvent)
                    emit(assistantEvent);
            }
        }
        catch {
            // message forwarding is best effort
        }
    });
    pi.on("agent_start", () => {
        try {
            if (!session)
                return;
            session.busy = true;
            const started = currentEvent("agent_start", {});
            if (started)
                emit(started);
        }
        catch {
            // ignore
        }
    });
    pi.on("agent_end", () => {
        try {
            if (!session)
                return;
            session.busy = false;
            const ended = currentEvent("agent_end", {});
            if (ended)
                emit(ended);
        }
        catch {
            // ignore
        }
    });
    pi.on("tool_execution_start", (event) => {
        try {
            const active = session;
            if (!active)
                return;
            const args = asRecord(event.args) ?? {};
            const started = currentEvent("tool_start", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                summary: summarizeArgs(args),
            });
            if (started)
                emit(started);
            if (!isSubagentToolName(event.toolName))
                return;
            const spawns = deriveSpawns(args);
            const startedAt = Date.now();
            const records = spawns.map((spawn, index) => ({
                childSessionId: spawns.length === 1
                    ? `tool:${event.toolCallId}`
                    : `tool:${event.toolCallId}#${index}`,
                agentName: spawn.agentName,
                startedAt,
            }));
            spawnChildren.set(event.toolCallId, records);
            for (const [index, spawn] of spawns.entries()) {
                const record = records[index];
                if (!record)
                    continue;
                const spawned = makeEvent({
                    type: "subagent_spawned",
                    sessionId: active.sessionId,
                    data: {
                        childSessionId: record.childSessionId,
                        agentName: spawn.agentName,
                        task: spawn.task,
                        callId: event.toolCallId,
                    },
                });
                emit(spawned);
            }
            envStack.set(event.toolCallId, {
                parent: process.env[ENV.parentSessionId],
                name: process.env[ENV.agentName],
            });
            process.env[ENV.parentSessionId] = active.sessionId;
            process.env[ENV.agentName] =
                spawns.length === 1 ? (spawns[0]?.agentName ?? "subagent") : "subagent";
        }
        catch {
            // tool forwarding is best effort
        }
    });
    pi.on("tool_execution_end", (event) => {
        try {
            const active = session;
            if (!active)
                return;
            const summary = summarizeResult(event.result);
            const durationMs = event.durationMs ?? 0;
            const ended = currentEvent("tool_end", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.isError,
                durationMs,
                summary,
            });
            if (ended)
                emit(ended);
            const spawns = spawnChildren.get(event.toolCallId);
            if (spawns) {
                const status = event.isError ? "failed" : "completed";
                for (const spawn of spawns) {
                    const completed = makeEvent({
                        type: "subagent_completed",
                        sessionId: active.sessionId,
                        data: {
                            childSessionId: spawn.childSessionId,
                            agentName: spawn.agentName,
                            status,
                            summary,
                            durationMs: event.durationMs ?? Math.max(0, Date.now() - spawn.startedAt),
                            callId: event.toolCallId,
                        },
                    });
                    emit(completed);
                }
                spawnChildren.delete(event.toolCallId);
            }
            restoreEnv(event.toolCallId);
        }
        catch {
            // tool forwarding is best effort
        }
    });
    pi.on("session_info_changed", (event) => {
        try {
            if (!session)
                return;
            const meta = currentEvent("session_meta", { title: event.name });
            if (meta)
                emit(meta);
        }
        catch {
            // ignore
        }
    });
    pi.on("session_shutdown", async (event) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        try {
            const active = session;
            if (active) {
                emit(makeEvent({
                    type: "session_ended",
                    sessionId: active.sessionId,
                    parentSessionId: active.parentSessionId,
                    agentName: active.agentName,
                    isSubagent: active.isSubagent,
                    data: { status: "completed", reason: event.reason },
                }));
            }
            const currentBridge = bridge;
            if (currentBridge) {
                try {
                    await currentBridge.shutdown();
                }
                catch {
                    // shutdown is best effort
                }
            }
            bridge = null;
            bridgePromise = null;
            for (const toolCallId of [...envStack.keys()])
                restoreEnv(toolCallId);
            spawnChildren.clear();
            session = null;
        }
        finally {
            shuttingDown = false;
        }
    });
}
//# sourceMappingURL=index.js.map