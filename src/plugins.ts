import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PluginInfo, PluginPanel } from "./protocol.js";
import { isPathInside, str, truncate } from "./protocol.js";

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MAX_PANELS = 8;
const MAX_PLUGINS = 24;
const ASSET_EXTENSIONS = new Set([
	".html",
	".htm",
	".js",
	".mjs",
	".css",
	".json",
	".svg",
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".woff2",
]);

/**
 * Resolves a plugin asset inside its own directory, rejecting traversal and
 * unknown extensions. `mustExist` additionally requires a regular file.
 */
function resolveAssetPath(baseDir: string, relativePath: string, mustExist: boolean): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(relativePath);
	} catch {
		return null;
	}
	if (decoded.includes("\0")) return null;
	const base = path.resolve(baseDir);
	const candidate = path.resolve(base, decoded.replace(/^\/+/, ""));
	if (!isPathInside(base, candidate)) return null;
	if (!ASSET_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return null;
	if (!mustExist) return candidate;
	try {
		if (!statSync(candidate).isFile()) return null;
	} catch {
		return null;
	}
	return candidate;
}

export class PluginError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface PluginRegistryOptions {
	/** Where the manifests are persisted, usually `<cache>/.plugins.json`. */
	statePath: string;
}

interface PluginRecord extends PluginInfo {
	/** Absolute directory the plugin's own files are served from. */
	dir: string;
}

function normalizeEntry(entry: string): string {
	const clean = entry.replace(/^\/+/, "");
	return clean.length > 0 ? clean : "panel.html";
}

/**
 * Registry of dashboard panels contributed by other pi extensions. A plugin
 * only ever exposes files from the directory it registered, and the dashboard
 * renders it in a sandboxed iframe so one plugin cannot reach into another.
 */
export class PluginRegistry {
	private readonly statePath: string;
	private readonly plugins = new Map<string, PluginRecord>();

	constructor(options: PluginRegistryOptions) {
		this.statePath = options.statePath;
		this.load();
	}

	list(): PluginInfo[] {
		return [...this.plugins.values()].map((plugin) => this.publicRecord(plugin));
	}

	get(id: string): PluginInfo | null {
		const record = this.plugins.get(id);
		return record ? this.publicRecord(record) : null;
	}

	register(input: unknown): PluginInfo {
		if (!input || typeof input !== "object") throw new PluginError(400, "plugin manifest must be an object");
		const record = input as Record<string, unknown>;
		const id = str(record.id).toLowerCase();
		if (!PLUGIN_ID.test(id)) {
			throw new PluginError(400, "id must be lowercase letters, digits or dashes (2-41 chars)");
		}
		const name = truncate(str(record.name) || id, 60);
		const dirInput = str(record.dir);
		if (!dirInput || !path.isAbsolute(dirInput)) throw new PluginError(400, "dir must be an absolute path");
		let dir: string;
		try {
			dir = realpathSync(dirInput);
		} catch {
			throw new PluginError(400, `dir does not exist: ${dirInput}`);
		}
		if (!statSync(dir).isDirectory()) throw new PluginError(400, `dir is not a directory: ${dir}`);

		const panelsInput = Array.isArray(record.panels) ? record.panels : [];
		const panels: PluginPanel[] = [];
		for (const raw of panelsInput.slice(0, MAX_PANELS)) {
			if (!raw || typeof raw !== "object") continue;
			const entry = raw as Record<string, unknown>;
			const panelId = str(entry.id) || "panel";
			const title = truncate(str(entry.title) || panelId, 60);
			const file = normalizeEntry(str(entry.entry) || "panel.html");
			if (!resolveAssetPath(dir, file, false)) {
				throw new PluginError(400, `panel entry is outside the plugin directory: ${file}`);
			}
			const height = Number(entry.height);
			const panel: PluginPanel = { id: panelId, title, entry: file };
			if (Number.isFinite(height) && height > 0) panel.height = Math.min(Math.round(height), 1200);
			if (str(entry.description)) panel.description = truncate(str(entry.description), 200);
			panels.push(panel);
		}
		if (panels.length === 0) {
			throw new PluginError(400, "at least one panel with an entry file is required");
		}
		if (!this.plugins.has(id) && this.plugins.size >= MAX_PLUGINS) {
			throw new PluginError(409, `at most ${MAX_PLUGINS} plugins can be registered`);
		}

		const next: PluginRecord = {
			id,
			name,
			panels,
			dir,
			registeredAt: Date.now(),
		};
		const description = str(record.description);
		if (description) next.description = truncate(description, 300);
		const version = str(record.version);
		if (version) next.version = truncate(version, 40);
		const events = Array.isArray(record.events)
			? record.events.filter((value): value is string => typeof value === "string").slice(0, 32)
			: [];
		if (events.length > 0) next.events = events;

		this.plugins.set(id, next);
		this.persist();
		return this.publicRecord(next);
	}

	remove(id: string): boolean {
		const removed = this.plugins.delete(id);
		if (removed) this.persist();
		return removed;
	}

	/** Resolves a plugin asset, refusing anything outside the registered dir. */
	assetPath(id: string, relativePath: string): string | null {
		const record = this.plugins.get(id);
		if (!record) return null;
		return resolveAssetPath(record.dir, relativePath, true);
	}

	private publicRecord(record: PluginRecord): PluginInfo {
		const info: PluginInfo = {
			id: record.id,
			name: record.name,
			panels: record.panels.map((panel) => ({ ...panel })),
			registeredAt: record.registeredAt,
		};
		if (record.description) info.description = record.description;
		if (record.version) info.version = record.version;
		if (record.events) info.events = [...record.events];
		return info;
	}

	private load(): void {
		if (!existsSync(this.statePath)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
		} catch {
			return;
		}
		if (!Array.isArray(parsed)) return;
		for (const entry of parsed) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const id = str(record.id);
			const dir = str(record.dir);
			if (!PLUGIN_ID.test(id) || !dir || !existsSync(dir)) continue;
			try {
				this.plugins.set(id, {
					id,
					name: str(record.name) || id,
					dir,
					panels: Array.isArray(record.panels)
						? (record.panels as PluginPanel[]).filter((panel) => panel && typeof panel.entry === "string")
						: [],
					registeredAt: Number(record.registeredAt) || Date.now(),
					...(str(record.description) ? { description: str(record.description) } : {}),
					...(str(record.version) ? { version: str(record.version) } : {}),
					...(Array.isArray(record.events)
						? { events: record.events.filter((value): value is string => typeof value === "string") }
						: {}),
				});
			} catch {
				// one broken manifest must not hide the others
			}
		}
	}

	private persist(): void {
		try {
			mkdirSync(path.dirname(this.statePath), { recursive: true });
			const records = [...this.plugins.values()].map((record) => ({
				id: record.id,
				name: record.name,
				dir: record.dir,
				panels: record.panels,
				registeredAt: record.registeredAt,
				...(record.description ? { description: record.description } : {}),
				...(record.version ? { version: record.version } : {}),
				...(record.events ? { events: record.events } : {}),
			}));
			writeFileSync(this.statePath, JSON.stringify(records, null, "\t"));
		} catch {
			// persistence is a convenience; the registry still works in memory
		}
	}
}
