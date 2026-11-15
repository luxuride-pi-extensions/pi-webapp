import { WebSocket } from "ws";
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const EVENT_BUFFER_LIMIT = 1000;
const POST_TIMEOUT_MS = 2500;
const CLOSE_GRACE_MS = 500;
const CLOSE_FLUSH_MS = 1500;
/**
 * Connects a pi process to a dashboard server that is already running in another
 * process. Commands arrive over the WebSocket; events leave over HTTP so they
 * survive short WebSocket interruptions.
 */
export class WebappClient {
    baseUrl;
    instanceId;
    options;
    ws = null;
    started = false;
    closed = false;
    connectedFlag = false;
    reconnectDelayMs = RECONNECT_MIN_MS;
    reconnectTimer = null;
    flushPromise = null;
    commandChain = Promise.resolve();
    queue = [];
    constructor(options) {
        this.options = options;
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.instanceId = options.instanceId;
    }
    get connected() {
        return this.connectedFlag;
    }
    get pendingCount() {
        return this.queue.length;
    }
    start() {
        if (this.started || this.closed)
            return;
        this.started = true;
        this.connect();
    }
    async stop() {
        if (this.closed)
            return;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Deliver anything queued (notably the final `session_ended`) before the
        // socket closes, so the server sees a clean shutdown instead of a crash.
        await this.flushBeforeClose(CLOSE_FLUSH_MS);
        this.closed = true;
        this.setConnected(false);
        const ws = this.ws;
        this.ws = null;
        if (!ws)
            return;
        await new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                try {
                    ws.terminate();
                }
                catch {
                    // already closed
                }
                done();
            }, CLOSE_GRACE_MS);
            ws.once("close", done);
            try {
                ws.close();
            }
            catch {
                done();
            }
        });
    }
    emit(event) {
        this.queue.push(event);
        if (this.queue.length > EVENT_BUFFER_LIMIT) {
            this.queue.splice(0, this.queue.length - EVENT_BUFFER_LIMIT);
        }
        void this.flush();
    }
    flush() {
        if (this.flushPromise)
            return this.flushPromise;
        if (this.closed)
            return Promise.resolve();
        const promise = this.drain();
        this.flushPromise = promise;
        void promise.finally(() => {
            if (this.flushPromise === promise)
                this.flushPromise = null;
        });
        return promise;
    }
    async flushBeforeClose(timeoutMs) {
        if (this.queue.length === 0)
            return;
        try {
            await Promise.race([
                this.flush(),
                new Promise((resolve) => {
                    const timer = setTimeout(resolve, timeoutMs);
                    timer.unref?.();
                }),
            ]);
        }
        catch {
            // Shutdown must never throw; undelivered events are simply lost.
        }
    }
    connect() {
        if (this.closed)
            return;
        let ws;
        try {
            ws = new WebSocket(this.webSocketUrl());
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;
        ws.on("open", () => {
            if (this.closed || this.ws !== ws)
                return;
            this.reconnectDelayMs = RECONNECT_MIN_MS;
            this.setConnected(true);
            this.send({ type: "hello", role: "instance", instanceId: this.instanceId });
            void this.flush();
        });
        ws.on("message", (data) => {
            void this.handleMessage(data);
        });
        ws.on("close", () => {
            if (this.ws === ws)
                this.ws = null;
            this.setConnected(false);
            if (!this.closed)
                this.scheduleReconnect();
        });
        ws.on("error", () => {
            try {
                ws.terminate();
            }
            catch {
                // close will follow when possible
            }
        });
    }
    async handleMessage(data) {
        let message;
        try {
            message = JSON.parse(data.toString());
        }
        catch {
            return;
        }
        if (!message || typeof message !== "object")
            return;
        const record = message;
        if (record.type === "ping") {
            this.send({ type: "pong" });
            return;
        }
        if (record.type === "model_command") {
            const command = parseModelCommand(record.command);
            if (!command)
                return;
            this.commandChain = this.commandChain.then(() => this.handleModelCommand(command));
            return;
        }
        if (record.type !== "command")
            return;
        const command = parsePromptCommand(record.command);
        if (!command)
            return;
        this.commandChain = this.commandChain.then(() => this.handleCommand(command));
    }
    async handleModelCommand(command) {
        let ok = false;
        let error;
        try {
            if (!this.options.onModelCommand) {
                error = "this pi instance cannot switch models from the dashboard";
            }
            else {
                const result = await this.options.onModelCommand(command);
                ok = result.ok === true;
                error = result.error;
            }
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        this.send({ type: "model_command_ack", commandId: command.id, ok, error });
    }
    /** Reports the models this instance can switch to. */
    sendModels(models) {
        this.send({ type: "models", models: [...models] });
    }
    async handleCommand(command) {
        let ok = false;
        let error;
        try {
            const result = await this.options.onCommand(command);
            ok = result.ok === true;
            error = result.error;
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        this.send({ type: "command_ack", commandId: command.id, ok, error });
    }
    async drain() {
        try {
            while (!this.closed && this.queue.length > 0) {
                const event = this.queue[0];
                if (!event)
                    break;
                const delivered = await this.postEvent(event);
                if (!delivered)
                    break;
                this.queue.shift();
            }
        }
        catch {
            // flushing must never surface failures to event emitters
        }
    }
    async postEvent(event) {
        try {
            const response = await fetch(`${this.baseUrl}/api/events`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ instanceId: this.instanceId, event }),
                signal: AbortSignal.timeout(POST_TIMEOUT_MS),
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    send(message) {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN)
            return;
        try {
            ws.send(JSON.stringify(message));
        }
        catch {
            // reconnection handles the next attempt
        }
    }
    scheduleReconnect() {
        if (this.closed || this.reconnectTimer)
            return;
        const base = Math.min(this.reconnectDelayMs, RECONNECT_MAX_MS);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
        const jitter = 0.8 + Math.random() * 0.4;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, Math.round(base * jitter));
    }
    setConnected(connected) {
        if (this.connectedFlag === connected)
            return;
        this.connectedFlag = connected;
        try {
            this.options.onConnectionChange?.(connected);
        }
        catch {
            // consumers must not break the connection state machine
        }
    }
    webSocketUrl() {
        try {
            const url = new URL(`${this.baseUrl}/ws`);
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
            url.searchParams.set("role", "instance");
            url.searchParams.set("instanceId", this.instanceId);
            return url.toString();
        }
        catch {
            // A malformed PI_WEBAPP_HOST/port must not crash pi; retrying is harmless.
            return "";
        }
    }
}
function parsePromptCommand(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const id = record.id;
    const sessionId = record.sessionId;
    const text = record.text;
    if (typeof id !== "string" || typeof sessionId !== "string" || typeof text !== "string") {
        return null;
    }
    const deliverAs = record.deliverAs;
    const command = {
        id,
        sessionId,
        text,
        deliverAs: deliverAs === "steer" || deliverAs === "followUp" ? deliverAs : "auto",
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    };
    if (typeof record.instanceId === "string")
        command.instanceId = record.instanceId;
    return command;
}
function parseModelCommand(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const id = record.id;
    const sessionId = record.sessionId;
    const provider = record.provider;
    const modelId = record.modelId;
    if (typeof id !== "string" ||
        typeof sessionId !== "string" ||
        typeof provider !== "string" ||
        typeof modelId !== "string") {
        return null;
    }
    const command = {
        id,
        sessionId,
        provider,
        modelId,
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    };
    if (typeof record.instanceId === "string")
        command.instanceId = record.instanceId;
    return command;
}
//# sourceMappingURL=client.js.map