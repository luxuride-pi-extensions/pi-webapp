import { useEffect, useMemo, useRef } from "preact/hooks";
import type { PluginInfo, SessionNode, WebappEvent } from "../../src/protocol.js";

export interface PluginPanelsProps {
	plugins: PluginInfo[];
	session: SessionNode | null;
	events: WebappEvent[];
	expandAll?: boolean;
}

const PANEL_MESSAGE_SOURCE = "pi-webapp";

/**
 * Panels contributed by other pi extensions. Each one runs in a sandboxed
 * iframe from its own directory, so dashboard code stays independent of the
 * plugins a user happens to have installed.
 */
export function PluginPanels({ plugins, session, events, expandAll = false }: PluginPanelsProps) {
	const sessionEvents = useMemo(
		() => (session ? events.filter((event) => event.sessionId === session.id).slice(-200) : []),
		[session, events],
	);

	if (!session || plugins.length === 0) return null;

	return (
		<section class="flex flex-col gap-2 px-4 pt-3" data-testid="plugin-panels">
			{plugins.map((plugin) =>
				plugin.panels.map((panel, index) => (
					<PluginPanelFrame
						key={`${plugin.id}/${panel.id}`}
						defaultOpen={expandAll || index === 0}
						plugin={plugin}
						panelId={panel.id}
						title={panel.title}
						entry={panel.entry}
						height={panel.height ?? 220}
						description={panel.description ?? plugin.description}
						session={session}
						events={sessionEvents}
					/>
				)),
			)}
		</section>
	);
}

function PluginPanelFrame({
	plugin,
	panelId,
	title,
	entry,
	height,
	description,
	session,
	events,
	defaultOpen,
}: {
	plugin: PluginInfo;
	panelId: string;
	title: string;
	entry: string;
	height: number;
	description?: string;
	session: SessionNode;
	events: WebappEvent[];
	defaultOpen?: boolean;
}) {
	const frameRef = useRef<HTMLIFrameElement | null>(null);

	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || !frame.contentWindow) return;
		const payload = {
			type: "pi-webapp:session",
			wo: PANEL_MESSAGE_SOURCE,
			session,
			events,
		};
		try {
			frame.contentWindow.postMessage(payload, "*");
		} catch {
			// a panel that is still loading will get the next update
		}
	}, [session, events]);

	const src = useMemo(() => {
		const params = new URLSearchParams({ session: session.id, theme: "dark" });
		return `/plugins/${encodeURIComponent(plugin.id)}/${entry}?${params.toString()}`;
	}, [plugin.id, entry, session.id]);

	return (
		<details
			class="collapse-arrow collapse rounded-md border border-base-300/60 bg-base-200/30"
			open={defaultOpen}
			data-testid="plugin-panel"
			data-plugin={plugin.id}
			data-panel={panelId}
		>
			<summary class="collapse-title flex items-center gap-2 text-xs font-semibold">
				<span class="badge badge-ghost badge-xs">plugin</span>
				{title}
				<span class="font-mono text-[10px] font-normal opacity-70">{plugin.name}</span>
			</summary>
			<div class="collapse-content pt-0">
				{description && <p class="mb-1 text-[11px] opacity-60">{description}</p>}
				<iframe
					ref={frameRef}
					class="w-full rounded-box border border-base-300 bg-base-100"
					style={{ height: `${height}px` }}
					src={src}
					sandbox="allow-scripts"
					title={`${plugin.name}: ${title}`}
					loading="lazy"
				/>
			</div>
		</details>
	);
}
