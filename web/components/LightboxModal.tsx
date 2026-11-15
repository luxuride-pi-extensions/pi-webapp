import { useEffect, useRef, useState } from "preact/hooks";
import type { MediaAsset } from "../../src/protocol.js";
import { formatBytes } from "./MediaCard";

export interface LightboxModalProps {
	asset: MediaAsset | null;
	onClose: () => void;
}

export function LightboxModal({ asset, onClose }: LightboxModalProps) {
	const [fit, setFit] = useState(true);
	const closeRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		setFit(true);
	}, [asset?.url]);

	useEffect(() => {
		if (!asset) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		closeRef.current?.focus();
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [asset, onClose]);

	if (!asset) return null;
	const isVideo = asset.kind === "video";

	return (
		<div
			class="modal modal-open z-50"
			role="dialog"
			aria-modal="true"
			aria-label={asset.filename}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div class="modal-box w-auto max-w-[95vw] bg-base-200 p-3">
				<div class="mb-2 flex items-center gap-2">
					<span class="truncate font-mono text-meta opacity-70" title={asset.filename}>
						{asset.filename}
					</span>
					<span class="badge badge-ghost badge-xs shrink-0">{formatBytes(asset.bytes)}</span>
					<a class="link link-primary shrink-0 text-meta" href={asset.url} target="_blank" rel="noreferrer">
						new tab
					</a>
					<div class="ml-auto flex items-center gap-1">
						{!isVideo && (
							<button
								type="button"
								class="btn btn-ghost btn-xs"
								onClick={() => setFit((value) => !value)}
								aria-pressed={!fit}
							>
								{fit ? "1:1" : "fit"}
							</button>
						)}
						<button
							ref={closeRef}
							type="button"
							class="btn btn-circle btn-ghost btn-sm"
							onClick={onClose}
							aria-label="Close preview"
						>
							✕
						</button>
					</div>
				</div>
				<div
					class={
						fit
							? "flex max-h-[85vh] items-center justify-center overflow-hidden"
							: "max-h-[85vh] overflow-auto"
					}
				>
					{isVideo ? (
						<video
							class="max-h-[85vh] max-w-full"
							src={asset.url}
							controls
							autoPlay
							playsInline
							preload="metadata"
						/>
					) : (
						<img
							class={fit ? "max-h-[85vh] max-w-full object-contain" : "max-w-none"}
							src={asset.url}
							alt={asset.filename}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
