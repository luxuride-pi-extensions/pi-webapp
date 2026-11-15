import { WebappClient } from "./client.js";
import { WebappServer } from "./server.js";
import { SessionSpawner } from "./spawn.js";
import { pruneArtifacts } from "./storage.js";
const PRUNE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LEECH_TIMEOUT_MS = 10_000;
function isAddressInUse(error) {
    const code = error && typeof error === "object" ? error.code : undefined;
    if (code === "EADDRINUSE")
        return true;
    const message = error instanceof Error ? error.message : String(error);
    return /EADDRINUSE|address already in use/i.test(message);
}
function toLeechStatus(value) {
    const record = value && typeof value === "object" ? value : {};
    const dirs = Array.isArray(record.dirs)
        ? record.dirs.filter((dir) => typeof dir === "string")
        : [];
    const status = {
        enabled: record.enabled === true,
        running: record.running === true,
        dirs,
        files: typeof record.files === "number" ? record.files : 0,
        sessions: typeof record.sessions === "number" ? record.sessions : 0,
    };
    if (typeof record.lastScanAt === "number")
        status.lastScanAt = record.lastScanAt;
    if (typeof record.lastError === "string")
        status.lastError = record.lastError;
    return status;
}
async function requestJson(url, init) {
    const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(LEECH_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`pi-webapp: request to ${url} failed with status ${response.status}`);
    }
    return response.json();
}
async function createClientBridge(options, handlerRef) {
    const baseUrl = `http://${options.host}:${options.port}`;
    const client = new WebappClient({
        baseUrl,
        instanceId: options.instanceId,
        onCommand: async (command) => {
            const handler = handlerRef.current;
            if (!handler)
                return { ok: false, error: "No prompt handler is registered" };
            try {
                const handled = await handler(command);
                return handled
                    ? { ok: true }
                    : { ok: false, error: "The session is not owned by this pi instance" };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    });
    client.start();
    let stopped = false;
    return {
        mode: "client",
        url: baseUrl,
        emit(event) {
            client.emit(event);
        },
        setPromptHandler(handler) {
            handlerRef.current = handler;
        },
        async rescanLeech(dirs) {
            const body = await requestJson(`${baseUrl}/api/leech/scan`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ dirs }),
            });
            return toLeechStatus(body);
        },
        async getLeechStatus() {
            try {
                return toLeechStatus(await requestJson(`${baseUrl}/api/leech`, { method: "GET" }));
            }
            catch {
                const body = await requestJson(`${baseUrl}/api/leech`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: "{}",
                });
                return toLeechStatus(body);
            }
        },
        async shutdown() {
            if (stopped)
                return;
            stopped = true;
            try {
                await client.stop();
            }
            catch {
                // shutdown is best effort
            }
        },
    };
}
export async function createBridge(options) {
    const server = new WebappServer({ host: options.host, port: options.port });
    try {
        await server.start();
    }
    catch (error) {
        try {
            await server.stop();
        }
        catch {
            // listen failed before the server owned any resources
        }
        if (!isAddressInUse(error))
            throw error;
        return createClientBridge(options, {
            current: null,
        });
    }
    try {
        const pruning = pruneArtifacts(server.artifactsRoot, PRUNE_MAX_AGE_MS);
        void Promise.resolve(pruning).catch(() => { });
    }
    catch {
        // pruning old artifacts is optional
    }
    let spawner = null;
    if (options.spawn !== false) {
        try {
            spawner = new SessionSpawner({
                rootDir: options.spawn?.rootDir,
                baseUrl: server.url,
                cwd: options.spawn?.cwd,
                sessionDir: options.spawn?.sessionDir,
                onChange: (record) => server.notifySpawnChange(record),
            });
            server.setSessionSpawner(spawner);
        }
        catch {
            spawner = null;
        }
    }
    let stopped = false;
    return {
        mode: "primary",
        url: server.url,
        emit(event) {
            server.ingest(event);
        },
        setPromptHandler(handler) {
            server.setLocalPromptHandler(handler);
        },
        rescanLeech(dirs) {
            return server.rescanLeech(dirs);
        },
        getLeechStatus() {
            return server.getLeechStatus();
        },
        async shutdown() {
            if (stopped)
                return;
            stopped = true;
            try {
                spawner?.stopAll();
            }
            catch {
                // ignore
            }
            try {
                await server.stop();
            }
            catch {
                // shutdown is best effort
            }
        },
    };
}
//# sourceMappingURL=bridge.js.map