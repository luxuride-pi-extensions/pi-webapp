import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { SpawnRecord } from "../../src/protocol.js";
import type { SpawnInput, StartSessionResult } from "../hooks/useWebSocket";

export interface NewSessionModalProps {
	open: boolean;
	defaultCwd: string;
	startSession: (input: SpawnInput) => Promise<StartSessionResult>;
	onSpawned: (spawn: SpawnRecord) => void;
	onClose: () => void;
}

export function NewSessionModal({ open, defaultCwd, startSession, onSpawned, onClose }: NewSessionModalProps) {
	const [cwd, setCwd] = useState(defaultCwd);
	const [prompt, setPrompt] = useState("");
	const [model, setModel] = useState("");
	const [agentName, setAgentName] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cwdRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setCwd(defaultCwd);
		setPrompt("");
		setModel("");
		setAgentName("");
		setSubmitting(false);
		setError(null);
	}, [open, defaultCwd]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || submitting) return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		cwdRef.current?.focus();
		cwdRef.current?.select();
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, submitting, onClose]);

	const canSubmit = cwd.trim().length > 0 && !submitting;

	const submit = useCallback(async () => {
		const workingDir = cwd.trim();
		if (!workingDir || submitting) return;
		setSubmitting(true);
		setError(null);
		const input: SpawnInput = { cwd: workingDir };
		const promptValue = prompt.trim();
		const modelValue = model.trim();
		const agentValue = agentName.trim();
		if (promptValue) input.prompt = promptValue;
		if (modelValue) input.model = modelValue;
		if (agentValue) input.agentName = agentValue;
		const result = await startSession(input);
		if (!result.ok || !result.spawn) {
			setSubmitting(false);
			setError(result.error ?? "The server did not return the new session");
			return;
		}
		setSubmitting(false);
		onSpawned(result.spawn);
		onClose();
	}, [cwd, prompt, model, agentName, submitting, startSession, onSpawned, onClose]);

	if (!open) return null;

	return (
		<div
			class="modal modal-open z-50"
			role="dialog"
			aria-modal="true"
			aria-labelledby="new-session-title"
			onClick={(event) => {
				if (event.target === event.currentTarget && !submitting) onClose();
			}}
		>
			<div class="modal-box w-full max-w-lg bg-base-200">
				<div class="flex items-start gap-2">
					<div class="min-w-0 flex-1">
						<h2 id="new-session-title" class="text-body font-semibold">
							Start a pi session
						</h2>
						<p class="mt-0.5 text-meta opacity-80">
							Launches a pi process in the working directory below and shows it in this dashboard.
						</p>
					</div>
					<button
						type="button"
						class="btn btn-circle btn-ghost btn-sm"
						onClick={onClose}
						disabled={submitting}
						aria-label="Close"
					>
						✕
					</button>
				</div>
				<form
					class="mt-4 flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<label class="flex flex-col gap-1">
						<span class="text-meta font-medium">
							Working directory <span class="text-error">*</span>
						</span>
						<input
							ref={cwdRef}
							type="text"
							class="input input-sm w-full border-base-300 font-mono text-body"
							value={cwd}
							required
							spellcheck={false}
							autocomplete="off"
							placeholder="/absolute/path/to/project"
							aria-label="Working directory"
							disabled={submitting}
							onInput={(event) => setCwd(event.currentTarget.value)}
						/>
						<span class="text-meta opacity-85">Absolute path where the pi session runs.</span>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-meta font-medium">Initial prompt</span>
						<textarea
							class="textarea textarea-sm min-h-[4.5rem] w-full resize-y border-base-300 font-mono text-body"
							rows={3}
							value={prompt}
							placeholder="Optional — the first message sent to the new session"
							aria-label="Initial prompt"
							disabled={submitting}
							onInput={(event) => setPrompt(event.currentTarget.value)}
						/>
						<span class="text-meta opacity-85">Delivered as the first message once the session starts.</span>
					</label>
					<div class="grid gap-3 sm:grid-cols-2">
						<label class="flex flex-col gap-1">
							<span class="text-meta font-medium">Model</span>
							<input
								type="text"
								class="input input-sm w-full border-base-300 font-mono text-body"
								value={model}
								spellcheck={false}
								autocomplete="off"
								placeholder="provider/model"
								aria-label="Model"
								disabled={submitting}
								onInput={(event) => setModel(event.currentTarget.value)}
							/>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-meta font-medium">Agent name</span>
							<input
								type="text"
								class="input input-sm w-full border-base-300 font-mono text-body"
								value={agentName}
								spellcheck={false}
								autocomplete="off"
								placeholder="optional label"
								aria-label="Agent name"
								disabled={submitting}
								onInput={(event) => setAgentName(event.currentTarget.value)}
							/>
						</label>
					</div>
					{error && (
						<div class="alert alert-error py-2 text-meta" role="alert">
							<span class="flex-1">{error}</span>
							<button type="button" class="btn btn-ghost btn-xs" onClick={() => setError(null)}>
								dismiss
							</button>
						</div>
					)}
					<div class="modal-action mt-1">
						<button type="button" class="btn btn-ghost btn-sm" onClick={onClose} disabled={submitting}>
							Cancel
						</button>
						<button type="submit" class="btn btn-primary btn-sm" disabled={!canSubmit}>
							{submitting && <span class="loading loading-spinner loading-xs" />}
							{submitting ? "Starting…" : "Start session"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
