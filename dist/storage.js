/**
 * Artifact storage helpers: cache location, safe path segments, MIME lookup and
 * the copy-on-ingest path used for screenshots and recordings.
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CACHE_DIR_NAME, ENV, MAX_MEDIA_BYTES, isPathInside, } from "./protocol.js";
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const VIDEO_EXTENSIONS = [".webm", ".mp4", ".mov"];
const ALLOWED_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAX_SEGMENT_LENGTH = 160;
const MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
};
/** Root directory used for copied screenshots and recordings. */
export function getCacheRoot() {
    const configured = process.env[ENV.cacheDir];
    if (configured)
        return configured;
    return path.join(os.homedir(), ".pi", "cache", CACHE_DIR_NAME);
}
/** Validate one path segment before it is joined below a trusted root. */
export function sanitizeSegment(value) {
    if (value.length === 0 ||
        value.length > MAX_SEGMENT_LENGTH ||
        value === "." ||
        value === ".." ||
        !ALLOWED_SEGMENT.test(value)) {
        throw new Error(`Invalid path segment: ${value}`);
    }
    return value;
}
/** Server-relative URL for an artifact copied into the cache. */
export function artifactUrl(sessionId, filename) {
    return `/artifacts/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;
}
/** Best-effort MIME lookup based on the final file extension. */
export function mimeForFile(file) {
    const extension = path.extname(file).toLowerCase();
    return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}
function extensionOf(file) {
    return path.extname(file).toLowerCase();
}
function expectedExtensions(kind) {
    return kind === "image" ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
}
function isAllowedExtension(kind, extension) {
    return expectedExtensions(kind).includes(extension);
}
function kindLabel(kind) {
    return kind === "image" ? "Screenshot" : "Recording";
}
/** Keep the original name readable while guaranteeing it is safe on disk. */
function safeArtifactName(sourceName) {
    const cleaned = sourceName
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[.-]+/, "")
        .slice(0, 120);
    if (!cleaned || cleaned === "." || cleaned === "..")
        return "artifact";
    return cleaned;
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Copy an external screenshot/recording into the session artifact directory.
 * Files already inside that directory are reused so repeated polls do not create
 * duplicate copies.
 */
export async function ingestArtifact(input) {
    const { root, sessionId, sourcePath, kind } = input;
    const resolvedSource = path.resolve(sourcePath);
    const extension = extensionOf(resolvedSource);
    if (!isAllowedExtension(kind, extension)) {
        throw new Error(`Unsupported ${kind} extension "${extension}" (expected ${expectedExtensions(kind).join(", ")})`);
    }
    let sourceInfo;
    try {
        sourceInfo = await stat(resolvedSource);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            throw new Error(`${kindLabel(kind)} not found: ${resolvedSource}`);
        }
        throw new Error(`${kindLabel(kind)} could not be read: ${resolvedSource} (${describeError(error)})`);
    }
    if (!sourceInfo.isFile()) {
        throw new Error(`${kindLabel(kind)} is not a file: ${resolvedSource}`);
    }
    if (sourceInfo.size === 0) {
        throw new Error(`File is empty: ${resolvedSource}`);
    }
    if (sourceInfo.size > MAX_MEDIA_BYTES) {
        throw new Error(`File too large: ${resolvedSource} (${sourceInfo.size} bytes, max ${MAX_MEDIA_BYTES} bytes)`);
    }
    const rootDir = path.resolve(root);
    const safeSessionId = sanitizeSegment(sessionId);
    const sessionDir = path.join(rootDir, safeSessionId);
    if (isPathInside(sessionDir, resolvedSource) && path.dirname(resolvedSource) === sessionDir) {
        const filename = path.basename(resolvedSource);
        return {
            kind,
            url: artifactUrl(safeSessionId, filename),
            filename,
            bytes: sourceInfo.size,
            mime: mimeForFile(filename),
        };
    }
    await mkdir(sessionDir, { recursive: true });
    const baseName = safeArtifactName(path.basename(resolvedSource));
    let filename = "";
    for (let attempt = 0; attempt < 5; attempt++) {
        filename = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}-${baseName}`;
        const destination = path.join(sessionDir, filename);
        try {
            await copyFile(resolvedSource, destination, fsConstants.COPYFILE_EXCL);
            return {
                kind,
                url: artifactUrl(safeSessionId, filename),
                filename,
                bytes: sourceInfo.size,
                mime: mimeForFile(filename),
            };
        }
        catch (error) {
            if (error.code === "EEXIST" && attempt < 4)
                continue;
            throw error;
        }
    }
    // The loop only exits here after exhausting collisions; keep the failure clear.
    throw new Error(`Could not allocate a unique artifact name in ${sessionDir}`);
}
async function newestMtime(directory) {
    let newest = (await stat(directory)).mtimeMs;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        try {
            const info = await stat(path.join(directory, entry.name));
            if (info.mtimeMs > newest)
                newest = info.mtimeMs;
        }
        catch {
            // A file racing with pruning must not hide the rest of the directory.
        }
    }
    return newest;
}
/**
 * Remove session artifact directories whose newest modification is older than
 * `maxAgeMs`. Intended for periodic housekeeping, so every error is swallowed.
 */
export async function pruneArtifacts(root, maxAgeMs) {
    const rootDir = path.resolve(root);
    let entries;
    try {
        entries = await readdir(rootDir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const fullPath = path.join(rootDir, entry.name);
        try {
            const newest = await newestMtime(fullPath);
            if (newest >= cutoff)
                continue;
            await rm(fullPath, { recursive: true, force: true });
            removed += 1;
        }
        catch {
            // Housekeeping must never surface filesystem races.
        }
    }
    return removed;
}
//# sourceMappingURL=storage.js.map