import type { ComponentChildren } from "preact";
import { useCallback, useMemo, useState } from "preact/hooks";
import { type HighlightToken, highlightTokens } from "../highlight";

export interface MarkdownTextProps {
	text: string;
	className?: string;
}

const MAX_CHARS = 12_000;
const INLINE_SOURCE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(_[^_\n]+_)|(https?:\/\/[^\s<>"']+)/g;
const LINK_TRAILING = /^(.*?)([.,;:!?)\]]*)$/;

function splitLink(token: string): { href: string; trailing: string } {
	const match = LINK_TRAILING.exec(token);
	return { href: match?.[1] ?? token, trailing: match?.[2] ?? "" };
}

function renderInline(text: string, prefix: string): ComponentChildren[] {
	const nodes: ComponentChildren[] = [];
	const pattern = new RegExp(INLINE_SOURCE.source, "g");
	let last = 0;
	let match: RegExpExecArray | null = pattern.exec(text);
	while (match) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		const token = match[0];
		const key = `${prefix}-${match.index}`;
		if (token.startsWith("`")) {
			nodes.push(
				<code key={key} class="rounded bg-base-300 px-1 py-0.5 font-mono text-[0.9em]">
					{token.slice(1, -1)}
				</code>,
			);
		} else if (token.startsWith("**")) {
			nodes.push(
				<strong key={key} class="font-semibold">
					{token.slice(2, -2)}
				</strong>,
			);
		} else if (token.startsWith("_")) {
			nodes.push(
				<em key={key} class="italic">
					{token.slice(1, -1)}
				</em>,
			);
		} else {
			const { href, trailing } = splitLink(token);
			nodes.push(
				<a key={key} href={href} target="_blank" rel="noreferrer noopener" class="link link-primary break-all">
					{href}
				</a>,
			);
			if (trailing) nodes.push(trailing);
		}
		last = match.index + token.length;
		match = pattern.exec(text);
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

function parseBlocks(source: string): ComponentChildren[] {
	const nodes: ComponentChildren[] = [];
	const lines = source.split("\n");
	let buffer: string[] = [];
	let lineIndex = 0;
	let blockIndex = 0;

	const flushText = () => {
		if (buffer.length === 0) return;
		const value = buffer.join("\n");
		buffer = [];
		const key = `text-${blockIndex++}`;
		nodes.push(<span key={key}>{renderInline(value, key)}</span>);
	};

	while (lineIndex < lines.length) {
		const line = lines[lineIndex] ?? "";
		if (/^```/.test(line)) {
			flushText();
			const language = line.replace(/^```/, "").trim();
			lineIndex += 1;
			const code: string[] = [];
			while (lineIndex < lines.length && !/^```\s*$/.test(lines[lineIndex] ?? "")) {
				code.push(lines[lineIndex] ?? "");
				lineIndex += 1;
			}
			lineIndex += 1; // closing fence (or end of input for an unclosed block)
			nodes.push(
				<CodeBlock key={`code-${blockIndex++}`} language={language} code={code.join("\n")} />,
			);
			continue;
		}
		buffer.push(line);
		lineIndex += 1;
	}
	flushText();
	return nodes;
}

interface CodeBlockProps {
	language: string;
	code: string;
}

function renderTokens(tokens: readonly HighlightToken[], prefix: string): ComponentChildren[] {
	return tokens.map((token, index) => {
		if (typeof token === "string") return token;
		return (
			<span key={`${prefix}-${index}`} class={`hljs-${token.kind}`}>
				{renderTokens(token.children, `${prefix}-${index}`)}
			</span>
		);
	});
}

function CodeBlock({ language, code }: CodeBlockProps) {
	const tokens = useMemo(() => highlightTokens(code, language), [code, language]);
	const [copied, setCopied] = useState(false);
	const copy = useCallback(() => {
		const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
		if (!clipboard) return;
		void clipboard.writeText(code).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_200);
		});
	}, [code]);
	return (
		<div class="group relative my-2">
			<pre class="hljs-pre overflow-x-auto rounded-box border border-base-300 bg-base-300/40 p-2 text-xs leading-relaxed">
				<code class="hljs font-mono" data-language={language || undefined}>
					{renderTokens(tokens, "hl")}
				</code>
			</pre>
			<div class="absolute top-1 right-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
				{language && <span class="badge badge-ghost badge-xs uppercase">{language}</span>}
				<button
					type="button"
					class="btn btn-ghost btn-xs h-6 min-h-0 px-1.5 font-mono"
					onClick={copy}
					title="Copy this code block"
					data-testid="copy-code"
				>
					{copied ? "copied" : "copy"}
				</button>
			</div>
		</div>
	);
}

/** Minimal safe Markdown: fenced code, inline code/bold/italic and bare links. */
export function MarkdownText({ text, className = "" }: MarkdownTextProps) {
	const source = typeof text === "string" ? text : "";
	const capped = source.length > MAX_CHARS ? `${source.slice(0, MAX_CHARS)}…truncated` : source;
	const blocks = useMemo(() => parseBlocks(capped), [capped]);
	return <div class={`wrap-anywhere whitespace-pre-wrap ${className}`}>{blocks}</div>;
}
