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
	/** Sticky "expand everything" mode requested from the toolbar. */
	expandAll?: boolean;
	/** Offered for sessions that are not managed by this dashboard. */
	onTakeOver?: (session: SessionNode) => void;
	takeoverBusyId?: string | null;
	onRemove?: (session: SessionNode) => void;
}

interface TreeNode {
	session: SessionNode;
	children: TreeNode[];
}

type StatusFilter = "all" | "running";

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
	const byStart = (a: SessionNode, b: SessionNode) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);
	const byActivity = (a: SessionNode, b: SessionNode) =>
		(b.updatedAt || b.startedAt) - (a.updatedAt || a.startedAt) || a.id.localeCompare(b.id);
	const build = (session: SessionNode, ancestors: ReadonlySet<string>): TreeNode => {
		const nextAncestors = new Set(ancestors);
		nextAncestors.add(session.id);
		const children = (childrenOf.get(session.id) ?? [])
			.filter((child) => !nextAncestors.has(child.id))
			.sort(byStart)
			.map((child) => build(child, nextAncestors));
		return { session, children };
	};
	return roots.sort(byActivity).map((root) => build(root, new Set()));
}

function nodeMatches(node: TreeNode, query: string, filter: StatusFilter): boolean {
	const { session } = node;
	if (filter === "running" && session.status !== "running") return false;
	if (!query) return true;
	const haystack = `${session.agentName ?? ""} ${session.title ?? ""} ${session.cwd ?? ""} ${session.id}`.toLowerCase();
	return haystack.includes(query);
}

/** Keeps nodes that match, plus every ancestor of a match. */
function filterForest(forest: TreeNode[], query: string, filter: StatusFilter): TreeNode[] {
	const prune = (node: TreeNode): TreeNode | null => {
		const children = node.children.map(prune).filter((child): child is TreeNode => child !== null);
		if (children.length > 0 || nodeMatches(node, query, filter)) return { session: node.session, children };
		return null;
	};
	return forest.map(prune).filter((node): node is TreeNode => node !== null);
}

function countNodes(forest: TreeNode[]): number {
	return forest.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

interface TreeRowProps {
	node: TreeNode;
	selectedSessionId: string | null;
	expandedIds: ReadonlySet<string>;
	activeSpawnIds: ReadonlySet<string>;
	canTakeOver: boolean;
	takeoverBusyId: string | null;
	onToggle: (id: string) => void;
	onSelect: (id: string) => void;
	onStopSpawn?: (spawnId: string) => void;
	onTakeOver?: (session: SessionNode) => void;
	onRemove?: (session: SessionNode) => void;
}

function TreeRow({
	node,
	selectedSessionId,
	expandedIds,
	activeSpawnIds,
	canTakeOver,
	takeoverBusyId,
	onToggle,
	onSelect,
	onStopSpawn,
	onTakeOver,
	onRemove,
}: TreeRowProps) {
	const { session, children } = node;
	const name = session.agentName ?? "session";
	const selected = selectedSessionId === session.id;
	const hasChildren = children.length > 0;
	const expanded = hasChildren && expandedIds.has(session.id);
	const spawnId = session.spawnId;
	const spawnActive = spawnId ? activeSpawnIds.has(spawnId) : false;
	const takeoverPending = !!session.takeoverSpawnId || takeoverBusyId === session.id;
	const takeoverAvailable = canTakeOver && session.source === "leech" && !session.isSubagent && !!onTakeOver;
	return (
		<div class="tree-node" data-testid="session-row" data-session-id={session.id}>
			<div
				class={`tree-line group flex items-start gap-0.5 rounded-lg border pr-1 transition-colors ${
					selected
						? "border-primary/40 bg-primary/15"
						: "border-transparent hover:border-base-300 hover:bg-base-300/50"
				}`}
			>
				<button
					type="button"
					class="mt-2 flex size-5 shrink-0 items-center justify-center rounded text-[10px] opacity-50 transition hover:bg-base-300 hover:opacity-100 disabled:opacity-20"
					onClick={() => onToggle(session.id)}
					aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
					aria-expanded={expanded}
					disabled={!hasChildren}
					data-testid="session-toggle"
				>
					{hasChildren ? (
						<span class={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
					) : null}
				</button>
				<button
					type="button"
					class="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-1 text-left"
					onClick={() => onSelect(session.id)}
					aria-current={selected ? "true" : undefined}
				>
					<span class="flex min-w-0 items-center gap-1.5">
						<span
							class="size-2 shrink-0 rounded-full"
							style={{ backgroundColor: agentColor(name) }}
							aria-hidden="true"
						/>
						<span class="truncate text-sm font-medium" title={name}>
							{name}
						</span>
						<StatusBadge status={session.status} source={session.source} />
						{spawnId && (
							<span class="badge badge-ghost badge-xs font-mono" title="Started from the dashboard">
								dashboard
							</span>
						)}
						{session.ownerPid !== undefined && (
							<span
								class={`badge badge-xs font-mono ${session.ownerBusy ? "badge-warning" : "badge-outline"}`}
								title={
									session.ownerBusy
										? `Session is busy in pi pid ${session.ownerPid}`
										: `Session is open in pi pid ${session.ownerPid}`
								}
							>
								pid {session.ownerPid}
							</span>
						)}
						{hasChildren && (
							<span class="ml-auto badge badge-ghost badge-xs" title={`${children.length} subagent(s)`}>
								{children.length}
							</span>
						)}
					</span>
					<span class="flex min-w-0 items-center gap-2 text-[11px] leading-tight opacity-60">
						<span class="truncate" title={session.title ?? ""}>
							{session.title ?? "untitled"}
						</span>
						<time class="ml-auto shrink-0 font-mono" title={new Date(session.startedAt).toLocaleString()}>
							{relativeTime(session.updatedAt || session.startedAt)}
						</time>
					</span>
				</button>
				{takeoverPending && (
					<span class="mt-2 self-start" title="Resuming this session…">
						<span class="loading loading-spinner loading-xs" />
					</span>
				)}
				{!takeoverPending && takeoverAvailable && (
					<button
						type="button"
						class="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded text-[12px] opacity-0 transition hover:bg-primary/20 hover:text-primary focus-visible:opacity-100 group-hover:opacity-60"
						title="Take over this session — resume it in a new pi process"
						aria-label={`Take over ${name}`}
						onClick={(event) => {
							event.stopPropagation();
							onTakeOver?.(session);
						}}
					>
						↻
					</button>
				)}
				{onRemove && (
					<button
						type="button"
						class="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded text-[12px] opacity-0 transition hover:bg-error/20 hover:text-error focus-visible:opacity-100 group-hover:opacity-60"
						title="Remove this session from the dashboard"
						aria-label={`Remove ${name}`}
						onClick={(event) => {
							event.stopPropagation();
							onRemove(session);
						}}
					>
						⌫
					</button>
				)}
				{spawnId && spawnActive && onStopSpawn && (
					<button
						type="button"
						class="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded text-[11px] opacity-0 transition hover:bg-error/20 hover:text-error focus-visible:opacity-100 group-hover:opacity-60"
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
				<div class="tree-children" data-testid="subagent-tree">
					{children.map((child) => (
						<TreeRow
							key={child.session.id}
							node={child}
							selectedSessionId={selectedSessionId}
							expandedIds={expandedIds}
							activeSpawnIds={activeSpawnIds}
							canTakeOver={canTakeOver}
							takeoverBusyId={takeoverBusyId}
							onToggle={onToggle}
							onSelect={onSelect}
							onStopSpawn={onStopSpawn}
							onTakeOver={onTakeOver}
							onRemove={onRemove}
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
	expandAll = false,
	onTakeOver,
	takeoverBusyId = null,
	onRemove,
}: SessionTreeProps) {
	// Explicit user choices win over the default (mains open, subagents closed).
	const [overrides, setOverrides] = useState<Record<string, boolean>>({});
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const forest = useMemo(() => buildForest(sessions), [sessions]);
	const normalizedQuery = query.trim().toLowerCase();
	const filtered = useMemo(
		() => filterForest(forest, normalizedQuery, statusFilter),
		[forest, normalizedQuery, statusFilter],
	);
	const expandedIds = useMemo(() => {
		const ids = new Set<string>();
		const walk = (node: TreeNode) => {
			const expanded = expandAll || (overrides[node.session.id] ?? !node.session.isSubagent);
			if (expanded) ids.add(node.session.id);
			node.children.forEach(walk);
		};
		forest.forEach(walk);
		return ids;
	}, [forest, expandAll, overrides]);
	const activeSpawnIds = useMemo(
		() =>
			new Set(
				spawns
					.filter((spawn) => spawn.status === "starting" || spawn.status === "running")
					.map((spawn) => spawn.spawnId),
			),
		[spawns],
	);
	const onToggle = useCallback(
		(id: string) => {
			setOverrides((previous) => ({ ...previous, [id]: !expandedIds.has(id) }));
		},
		[expandedIds],
	);

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
		<div class="flex min-h-0 flex-col">
			<div class="flex flex-col gap-1.5 border-b border-base-300 p-2">
				<label class="input input-xs flex w-full items-center gap-1 rounded-md border-base-300 bg-base-200">
					<span class="text-[11px] opacity-50" aria-hidden="true">
						⌕
					</span>
					<input
						type="search"
						class="grow bg-transparent text-xs outline-none placeholder:opacity-50"
						placeholder="Filter sessions…"
						value={query}
						onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
						data-testid="session-search"
						aria-label="Filter sessions"
					/>
					{query && (
						<button
							type="button"
							class="text-[11px] opacity-50 hover:opacity-100"
							onClick={() => setQuery("")}
							aria-label="Clear filter"
						>
							✕
						</button>
					)}
				</label>
				<div class="flex items-center gap-1 text-[11px]">
					{(["all", "running"] as const).map((value) => (
						<button
							key={value}
							type="button"
							class={`btn btn-xs rounded-md ${statusFilter === value ? "btn-primary" : "btn-ghost"}`}
							aria-pressed={statusFilter === value}
							onClick={() => setStatusFilter(value)}
							data-testid="status-filter"
						>
							{value}
						</button>
					))}
					<span class="ml-auto font-mono opacity-50">{countNodes(filtered)}</span>
				</div>
			</div>
			<nav aria-label="Sessions" class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2" data-testid="session-tree">
				{filtered.length === 0 ? (
					<p class="px-2 py-6 text-center text-xs opacity-50">No sessions match this filter.</p>
				) : (
					filtered.map((node) => (
						<TreeRow
							key={node.session.id}
							node={node}
							selectedSessionId={selectedSessionId}
							expandedIds={expandedIds}
							activeSpawnIds={activeSpawnIds}
							canTakeOver={!!onTakeOver}
							takeoverBusyId={takeoverBusyId}
							onToggle={onToggle}
							onSelect={onSelect}
							onStopSpawn={onStopSpawn}
							onTakeOver={onTakeOver}
							onRemove={onRemove}
						/>
					))
				)}
			</nav>
		</div>
	);
}
