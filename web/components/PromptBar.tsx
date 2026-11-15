import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { DeliverAs, PromptResponse, SessionNode } from "../../src/protocol.js";
import { sessionName } from "../format.js";

export interface PromptBarProps {
	target: SessionNode | null;
	onSend: (text: string, deliverAs: DeliverAs) => Promise<PromptResponse>;
	disabled?: boolean;
	/**
	 * Only needed when another pi process still holds the transcript. A leeched
	 * session nobody is running can simply be prompted: the dashboard resumes it.
	 */
	onTakeOver?: (target: SessionNode) => void;
	takingOver?: boolean;
}

const DELIVERY_MODES: DeliverAs[] = ["auto", "steer", "followUp"];

export function PromptBar({ target, onSend, disabled = false, onTakeOver, takingOver = false }: PromptBarProps) {
	const [text, setText] = useState("");
	const [deliverAs, setDeliverAs] = useState<DeliverAs>("auto");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const sentTimer = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (sentTimer.current !== null) window.clearTimeout(sentTimer.current);
		};
	}, []);

	// A leeched transcript that no pi process owns is idle: prompting it resumes
	// it in a fresh process. Only an owner that is still running needs a takeover.
	const leeched = target?.source === "leech";
	const owned = leeched && target?.ownerPid !== undefined;
	const idleLeech = leeched && !owned;
	const blocked = !target || owned || disabled;
	const hint = !target
		? "Select a session to send a prompt."
		: idleLeech
			? "Not running in pi — sending resumes this transcript in a new pi process."
			: null;
	const name = target ? sessionName(target) : "session";
	const label = target ? `Send to ${name}` : "Send";

	const submit = useCallback(async () => {
		const value = text.trim();
		if (!value || !target || blocked || sending) return;
		setSending(true);
		setError(null);
		setSent(false);
		const result = await onSend(value, deliverAs);
		setSending(false);
		if (!result.ok) {
			setError(result.error ?? "Prompt was not delivered");
			return;
		}
		setText("");
		setSent(true);
		if (sentTimer.current !== null) window.clearTimeout(sentTimer.current);
		sentTimer.current = window.setTimeout(() => setSent(false), 3_000);
	}, [text, target, blocked, sending, onSend, deliverAs]);

	if (owned && target) {
		const pid = target.ownerPid;
		const busy = target.ownerBusy === true;
		return (
			<div class="flex items-center gap-3 border-t border-base-300 bg-base-100 px-3 py-2 text-meta">
				<span class="min-w-0 truncate opacity-70">
					{busy
						? `Busy in pi pid ${pid} — wait for the current turn to finish.`
						: `Still open in pi pid ${pid} — take it over to prompt it from here.`}
				</span>
				{onTakeOver && (
					<button
						type="button"
						class="btn btn-primary btn-xs ml-auto shrink-0"
						disabled={takingOver}
						onClick={() => onTakeOver(target)}
						title="Stop the owning pi process and resume this session in a new one"
					>
						{takingOver && <span class="loading loading-spinner loading-xs" />}
						{takingOver ? "taking over…" : "take over"}
					</button>
				)}
			</div>
		);
	}

	return (
		<div class="border-t border-base-300 bg-base-100 px-3 py-2">
			{hint && <div class="mb-1.5 text-meta opacity-60">{hint}</div>}
			{error && (
				<div class="alert alert-error mb-2 py-1.5 text-meta" role="alert">
					<span class="flex-1">{error}</span>
					<button type="button" class="btn btn-ghost btn-xs" onClick={() => setError(null)}>
						dismiss
					</button>
				</div>
			)}
			{sent && (
				<div class="mb-1.5 text-meta text-success" role="status">
					sent
				</div>
			)}
			<div class="rounded-box border border-base-300 bg-base-100 transition-colors focus-within:border-primary/60">
				<textarea
					class="block w-full resize-none bg-transparent px-3 py-2 font-mono text-body leading-relaxed outline-none placeholder:opacity-45"
					rows={2}
					value={text}
					placeholder={`Message ${name}…`}
					disabled={blocked || sending}
					aria-label={label}
					data-testid="prompt-input"
					onInput={(event) => setText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				<div class="flex items-center gap-2 border-t border-base-300/60 px-2 py-1.5">
					<select
						class="select select-xs w-auto border-base-300 font-mono text-micro"
						value={deliverAs}
						disabled={sending}
						aria-label="Delivery mode"
						title="auto steers a running agent and queues a follow-up when idle"
						onChange={(event) => setDeliverAs(event.currentTarget.value as DeliverAs)}
					>
						{DELIVERY_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</select>
					<span class="hidden text-micro opacity-45 sm:inline">⏎ send · ⇧⏎ newline</span>
					<button
						type="button"
						class="btn btn-primary btn-sm ml-auto gap-1.5 whitespace-nowrap px-3"
						disabled={blocked || sending || text.trim().length === 0}
						onClick={() => void submit()}
					>
						{sending && <span class="loading loading-spinner loading-xs" />}
						{sending ? "Sending…" : "Send"}
					</button>
				</div>
			</div>
		</div>
	);
}
