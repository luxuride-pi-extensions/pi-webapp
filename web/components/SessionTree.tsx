import { useCallback, useMemo, useState } from "preact/hooks";
import type { SessionNode, SpawnRecord } from "../../src/protocol.js";
import { StatusBadge } from "./StatusBadge";

export interface SessionTreeProps {
	sessions: SessionNode[];
	selectedSessionId: string | null;
	onSelect: (id: string) => void;
	/** Dashboard-launched processes, used to gate the per-session stop button. */
	spawns?: SpawnRecord[];
	onStopSpawn?: (spawnId: string) => void;
}

interface TreeNode {
	session: SessionNode;
	children: TreeNode[];
}

const AGENT_COLORS = ["#8ab4ff", "#c39bff", "#6fd3a8", "#ffb86b", "#ff8fa3", "#7ad7e6"];

function agentColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
	return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length] ?? AGENT_COLORS[0];
}

function relativeTime(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "";
	const seconds = Math.round((Date.now() - timestamp) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 3_600) return `${Math.max(1, Math.round(seconds / 60))}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}

function buildForest(sessions: SessionNode[]): TreeNode[] {
	const byId = new Map(sessions.map((session) => [session.id, session]));
	const childrenOf = new Map<string, SessionNode[]>();
	const roots: SessionNode[] = [];
	for (const session of sessions) {
		const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
		if (parent && parent.id !== session.id) {
			const siblings = childrenOf.get(parent.id) ?? [];
			siblings.push(session);
			childrenOf.set(parent.id, siblings);
		} else {
			roots.push(session);
		}
	}
	const compare = (a: SessionNode, b: SessionNode) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
	const build = (session: SessionNode, ancestors: ReadonlySet<string>): TreeNode => {
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(session.id);
		const children = (childrenOf.get(session.id) ?? [])
			.filter((child) => !nextAncestors.has(child.id))
			.sort(compare)
			.map((child) => build(child, nextAncestors));
		return { session, children };
	};
	return roots.sort(compare).map((root) => build(root, new Set()));
}

interface TreeRowProps {
	node: TreeNode;
	selectedSessionId: string | null;
	collapsed: ReadonlySet<string>;
	activeSpawnIds: ReadonlySet<string>;
	onToggle: (id: string) => void;
	onSelect: (id: string) => void;
	onStopSpawn?: (spawnId: string) => void;
}

function TreeRow({ node, selectedSessionId, collapsed, activeSpawnIds, onToggle, onSelect, onStopSpawn }: TreeRowProps) {
	const { session, children } = node;
	const name = session.agentName ?? "session";
	const selected = selectedSessionId === session.id;
	const hasChildren = children.length > 0;
	const expanded = hasChildren && !collapsed.has(session.id);
	const spawnId = session.spawnId;
	const spawnActive = spawnId ? activeSpawnIds.has(spawnId) : false;
	return (
		<div class="tree-node">
			<div
				class={`tree-line flex items-start gap-1 rounded-md border border-transparent pr-1 ${
					selected ? "border-primary/30 bg-primary/15 ring-1 ring-primary/30" : "hover:bg-base-300/60"
				}`}
			>
				<button
					type="button"
					class="mt-2 flex size-4 shrink-0 items-center justify-center rounded text-[10px] opacity-60 hover:opacity-100"
					onClick={() => onToggle(session.id)}
					aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
					aria-expanded={expanded}
					disabled={!hasChildren}
				>
					{hasChildren ? (
						<span class={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
					) : null}
				</button>
				<button
					type="button"
					class="flex min-w-0 flex-1 flex-col gap-0.5 py-1 pr-1 text-left"
					onClick={() => onSelect(session.id)}
					aria-current={selected ? "true" : undefined}
				>
					<span class="flex min-w-0 items-center gap-1.5">
						<span
							class="size-2 shrink-0 rounded-full"
							style={{ backgroundColor: agentColor(name) }}
							aria-hidden="true"
						/>
						<span class="truncate text-sm font-medium">{name}</span>
						<StatusBadge status={session.status} source={session.source} />
						{spawnId && (
							<span class="badge badge-ghost badge-xs font-mono" title="Started from the dashboard">
								dashboard
							</span>
						)}
						{hasChildren && <span class="ml-auto badge badge-ghost badge-xs">{children.length}</span>}
					</span>
					<span class="flex min-w-0 items-center gap-2 text-[11px] opacity-60">
						<span class="truncate" title={session.title ?? ""}>
							{session.title ?? "untitled"}
						</span>
						<time class="ml-auto shrink-0 font-mono">{relativeTime(session.startedAt)}</time>
					</span>
				</button>
				{spawnId && spawnActive && onStopSpawn && (
					<button
						type="button"
						class="mt-1 flex size-5 shrink-0 items-center justify-center rounded text-[11px] opacity-50 hover:bg-error/20 hover:text-error hover:opacity-100"
						title="Stop this pi process"
						aria-label={`Stop ${name}`}
						onClick={(event) => {
							event.stopPropagation();
							onStopSpawn(spawnId);
						}}
					>
						✕
					</button>
				)}
			</div>
			{expanded && (
				<div class="tree-children">
					{children.map((child) => (
						<TreeRow
							key={child.session.id}
							node={child}
							selectedSessionId={selectedSessionId}
							collapsed={collapsed}
							activeSpawnIds={activeSpawnIds}
							onToggle={onToggle}
							onSelect={onSelect}
							onStopSpawn={onStopSpawn}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function SessionTree({
	sessions,
	selectedSessionId,
	onSelect,
	spawns = [],
	onStopSpawn,
}: SessionTreeProps) {
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const forest = useMemo(() => buildForest(sessions), [sessions]);
	const activeSpawnIds = useMemo(
		() =>
			new Set(
				spawns.filter((spawn) => spawn.status === "starting" || spawn.status === "running").map((spawn) => spawn.spawnId),
			),
		[spawns],
	);
	const onToggle = useCallback((id: string) => {
		setCollapsed((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	if (sessions.length === 0) {
		return (
			<div class="p-3">
				<div class="alert items-start border border-base-300 bg-base-200 p-3 text-xs">
					<div class="space-y-1">
						<p class="font-semibold">No sessions yet</p>
						<p>
							Start a session with the <span class="font-semibold">New session</span> button, run{" "}
							<code class="rounded bg-base-300 px-1 font-mono">pi</code> with the pi-webapp extension installed, or set{" "}
							<code class="rounded bg-base-300 px-1 font-mono">PI_WEBAPP_LEECH=1</code> to tail existing transcripts.
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<nav aria-label="Sessions" class="flex flex-col gap-0.5 p-2">
			{forest.map((node) => (
				<TreeRow
					key={node.session.id}
					node={node}
					selectedSessionId={selectedSessionId}
					collapsed={collapsed}
					activeSpawnIds={activeSpawnIds}
					onToggle={onToggle}
					onSelect={onSelect}
					onStopSpawn={onStopSpawn}
				/>
			))}
		</nav>
	);
}
