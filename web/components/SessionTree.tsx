import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { SessionNode, SpawnRecord } from "../../src/protocol.js";
import { sessionName } from "../format.js";

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
	onRename?: (session: SessionNode) => void;
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
	onContextMenu: (session: SessionNode, x: number, y: number) => void;
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
	onContextMenu,
}: TreeRowProps) {
	const { session, children } = node;
	const name = sessionName(session);
	const selected = selectedSessionId === session.id;
	const hasChildren = children.length > 0;
	const expanded = hasChildren && expandedIds.has(session.id);
	const spawnId = session.spawnId;
	const spawnActive = spawnId ? activeSpawnIds.has(spawnId) : false;
	const takeoverPending = !!session.takeoverSpawnId || takeoverBusyId === session.id;
	const rowTitle = [
		name,
		session.status,
		session.source === "leech" ? "leeched" : "",
		session.ownerPid !== undefined ? `pid ${session.ownerPid}${session.ownerBusy ? " (busy)" : ""}` : "",
		spawnId ? "started from the dashboard" : "",
		session.title && session.title !== name ? session.title : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div class="tree-node" data-testid="session-row" data-session-id={session.id}>
			<div
				class={`tree-line group flex items-center gap-0.5 rounded-md pr-1 transition-colors ${
					selected ? "bg-primary/15" : "hover:bg-base-300/60"
				}`}
				onContextMenu={(event) => {
					event.preventDefault();
					onSelect(session.id);
					onContextMenu(session, event.clientX, event.clientY);
				}}
				data-testid="session-row-body"
				title={rowTitle}
			>
				<button
					type="button"
					class="flex size-5 shrink-0 items-center justify-center rounded text-[10px] opacity-40 transition hover:bg-base-300 hover:opacity-100 disabled:opacity-0"
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
					class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-1 text-left"
					onClick={() => onSelect(session.id)}
					aria-current={selected ? "true" : undefined}
				>
					<span class="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: agentColor(name) }} aria-hidden="true" />
					<span class={`truncate text-[13px] ${session.isSubagent ? "font-normal" : "font-medium"}`}>{name}</span>
					{session.status === "running" && (
						<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-success" aria-label="running" />
					)}
					{session.status === "completed" && (
					<span class="shrink-0 text-[10px] text-success/50" aria-label="completed">
						✓
					</span>
				)}
					{session.status === "failed" && (
						<span class="shrink-0 text-[10px] text-error" aria-label="failed">
							✕
						</span>
					)}
					{hasChildren && !expanded && (
						<span class="shrink-0 font-mono text-[10px] opacity-40" title={`${children.length} subagent(s)`}>
							+{children.length}
						</span>
					)}
					<span class="ml-auto flex shrink-0 items-center gap-1">
						{takeoverPending && <span class="loading loading-spinner loading-xs" title="Resuming this session…" />}
						{spawnActive && (
							<span class="size-1 rounded-full bg-info" title="Started from the dashboard" aria-hidden="true" />
						)}
						<time class="font-mono text-[10px] tabular-nums opacity-35">
							{relativeTime(session.updatedAt || session.startedAt)}
						</time>
					</span>
				</button>
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
							onContextMenu={onContextMenu}
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
	onRename,
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
	const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
	const openMenu = useCallback((session: SessionNode, x: number, y: number) => {
		setMenu({ sessionId: session.id, x, y });
	}, []);
	const closeMenu = useCallback(() => setMenu(null), []);
	useEffect(() => {
		if (!menu) return;
		const onPointerDown = (event: Event) => {
			const target = event.target as Element | null;
			if (target?.closest('[data-testid="session-menu"]')) return;
			closeMenu();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") closeMenu();
		};
		window.addEventListener("pointerdown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("resize", closeMenu);
		window.addEventListener("blur", closeMenu);
		return () => {
			window.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("resize", closeMenu);
			window.removeEventListener("blur", closeMenu);
		};
	}, [menu, closeMenu]);
	const canTakeOver = !!onTakeOver;
	const menuSession = menu ? sessions.find((session) => session.id === menu.sessionId) : undefined;
	const menuStyle = menu
		? {
				left: `${Math.min(menu.x, Math.max(0, window.innerWidth - 240))}px`,
				top: `${Math.min(menu.y, Math.max(0, window.innerHeight - 220))}px`,
			}
		: undefined;
	const menuHasChildren = menuSession
		? sessions.some((session) => session.parentSessionId === menuSession.id)
		: false;
	const menuSpawnId = menuSession?.spawnId;
	const menuTakeoverPending = menuSession
		? !!menuSession.takeoverSpawnId || takeoverBusyId === menuSession.id
		: false;
	const menuTakeover = menuSession
		? canTakeOver && menuSession.source === "leech" && !menuSession.isSubagent
		: false;

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
			<div class="flex flex-col gap-1 border-b border-base-300 px-2 py-1.5">
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
				<div class="flex items-center gap-0.5 text-[11px]">
					{(["all", "running"] as const).map((value) => (
						<button
							key={value}
							type="button"
							class={`btn btn-ghost btn-xs h-6 min-h-0 px-2 font-normal ${statusFilter === value ? "bg-base-300 text-base-content" : "opacity-50"}`}
							aria-pressed={statusFilter === value}
							onClick={() => setStatusFilter(value)}
							data-testid="status-filter"
						>
							{value}
						</button>
					))}
					<span class="ml-auto font-mono text-[10px] opacity-35">{countNodes(filtered)}</span>
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
							onContextMenu={openMenu}
						/>
					))
				)}
			</nav>
			{menu && menuSession ? (
				<ul
					class="menu menu-sm fixed z-50 w-56 rounded-box border border-base-300 bg-base-200 p-1 shadow-2xl"
					style={menuStyle}
					data-testid="session-menu"
					role="menu"
				>
					<li class="menu-title py-0.5 text-[10px] tracking-wide uppercase">
						<span class="max-w-44 truncate normal-case">{sessionName(menuSession)}</span>
					</li>
					{menuHasChildren && (
						<li>
							<button
								type="button"
								draggable={false}
								onClick={() => {
									onToggle(menuSession.id);
									closeMenu();
							}}
								data-testid="menu-toggle"
							>
								{expandedIds.has(menuSession.id) ? "Collapse subagents" : "Expand subagents"}
							</button>
						</li>
					)}
					{onRename && (
						<li>
							<button
								type="button"
								draggable={false}
								data-testid="menu-rename"
								onClick={() => {
									closeMenu();
									onRename(menuSession);
								}}
							>
								Rename…
							</button>
						</li>
					)}
					{menuTakeover && onTakeOver && (
						<li>
							<button
								type="button"
								draggable={false}
								disabled={menuTakeoverPending}
								data-testid="menu-takeover"
								title="Resume this transcript in a new pi process"
								onClick={() => {
									closeMenu();
									onTakeOver(menuSession);
								}}
							>
								{menuTakeoverPending ? "Resuming…" : "Take over session"}
							</button>
						</li>
					)}
					{menuSpawnId && activeSpawnIds.has(menuSpawnId) && onStopSpawn && (
						<li>
							<button
								type="button"
								draggable={false}
								data-testid="menu-stop"
								onClick={() => {
									closeMenu();
									onStopSpawn(menuSpawnId);
								}}
							>
								Stop pi process
							</button>
						</li>
					)}
					{onRemove && (
						<li>
							<button
								type="button"
								draggable={false}
								class="text-error"
								data-testid="menu-remove"
								onClick={() => {
									closeMenu();
									onRemove(menuSession);
								}}
							>
								Remove session
							</button>
						</li>
					)}
				</ul>
			) : null}
		</div>
	);
}
