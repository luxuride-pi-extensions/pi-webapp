import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { DeliverAs, PromptResponse, SessionNode } from "../../src/protocol.js";
import { sessionName } from "../format.js";

export interface PromptBarProps {
	target: SessionNode | null;
	onSend: (text: string, deliverAs: DeliverAs) => Promise<PromptResponse>;
	disabled?: boolean;
	/** Offered instead of a disabled input while a leeched session is selected. */
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

	const blocked = !target || target.source === "leech" || disabled;
	const leeched = target?.source === "leech";
	const hint = !target ? "Select a session to send a prompt." : null;
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

	if (leeched && target) {
		return (
			<div class="flex items-center gap-3 border-t border-base-300 bg-base-100 px-3 py-2 text-xs">
				<span class="min-w-0 truncate opacity-50">
					Leeched transcript — read only until it is resumed in a pi process.
				</span>
				{onTakeOver && (
					<button
						type="button"
						class="btn btn-primary btn-xs ml-auto shrink-0"
						disabled={takingOver}
						onClick={() => onTakeOver(target)}
						title="Resume this session in a new pi process and prompt it from here"
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
			{hint && <div class="mb-1.5 text-[11px] opacity-60">{hint}</div>}
			{error && (
				<div class="alert alert-error mb-2 py-1.5 text-xs" role="alert">
					<span class="flex-1">{error}</span>
					<button type="button" class="btn btn-ghost btn-xs" onClick={() => setError(null)}>
						dismiss
					</button>
				</div>
			)}
			{sent && (
				<div class="mb-1.5 text-xs text-success" role="status">
					sent
				</div>
			)}
			<div class="flex items-end gap-2">
				<textarea
					class="textarea textarea-sm min-h-[3rem] flex-1 resize-none border-base-300 font-mono text-sm leading-relaxed"
					rows={2}
					value={text}
					placeholder={hint ?? `Message ${name}…  ⏎ send · ⇧⏎ newline`}
					disabled={blocked || sending}
					aria-label={label}
					onInput={(event) => setText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
				/>
				<div class="flex flex-col gap-1">
					<select
						class="select select-xs border-base-300 font-mono text-[11px]"
						value={deliverAs}
						disabled={sending}
						aria-label="Delivery mode"
						onChange={(event) => setDeliverAs(event.currentTarget.value as DeliverAs)}
					>
						{DELIVERY_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{mode}
							</option>
						))}
					</select>
					<button
						type="button"
						class="btn btn-primary btn-sm whitespace-nowrap px-3"
						disabled={blocked || sending || text.trim().length === 0}
						onClick={() => void submit()}
					>
						{sending && <span class="loading loading-spinner loading-xs" />}
						{sending ? "Sending…" : label}
					</button>
				</div>
			</div>
		</div>
	);
}
