import { useState } from "preact/hooks";
import type { MediaAsset } from "../../src/protocol.js";

export interface MediaCardProps {
	asset: MediaAsset;
	onOpenImage: (asset: MediaAsset) => void;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function MediaCard({ asset, onOpenImage }: MediaCardProps) {
	const [failed, setFailed] = useState(false);
	const isVideo = asset.kind === "video";
	const span = isVideo ? "sm:col-span-2" : "";

	if (failed) {
		return (
			<div class={`alert alert-warning p-2 text-xs ${span}`} role="status">
				<span class="truncate font-mono">{asset.filename}</span>
				<span>artifact unavailable</span>
			</div>
		);
	}

	return (
		<figure class={`overflow-hidden rounded-box border border-base-300 bg-base-300/25 ${span}`}>
			{isVideo ? (
				<video
					class="max-h-72 w-full bg-black"
					src={asset.url}
					controls
					preload="metadata"
					playsInline
					onError={() => setFailed(true)}
				/>
			) : (
				<button
					type="button"
					class="block w-full cursor-zoom-in"
					onClick={() => onOpenImage(asset)}
					aria-label={`Open ${asset.filename}`}
				>
					<img
						class="max-h-64 w-full object-cover"
						src={asset.url}
						alt={asset.filename}
						loading="lazy"
						onError={() => setFailed(true)}
					/>
				</button>
			)}
			<figcaption class="flex items-center gap-2 px-2 py-1 text-[11px]">
				<span class="truncate font-mono opacity-70" title={asset.filename}>
					{asset.filename}
				</span>
				<span class="ml-auto shrink-0 opacity-50">{formatBytes(asset.bytes)}</span>
				{isVideo && (
					<a class="link link-primary shrink-0" href={asset.url} download={asset.filename} rel="noreferrer">
						download
					</a>
				)}
			</figcaption>
		</figure>
	);
}
