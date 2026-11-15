import { marked, type Token, type Tokens } from "marked";
import type { ComponentChildren } from "preact";
import { useCallback, useMemo, useState } from "preact/hooks";
import { type HighlightToken, highlightTokens } from "../highlight";

export interface MarkdownTextProps {
	text: string;
	className?: string;
}

/** Long tool output is capped before parsing so the lexer never stalls a frame. */
const MAX_CHARS = 12_000;
const SAFE_HREF = /^(https?:\/\/|mailto:|#)/i;

marked.use({ gfm: true, breaks: true });

function safeHref(href: string | null | undefined): string | null {
	if (!href) return null;
	const trimmed = href.trim();
	return SAFE_HREF.test(trimmed) ? trimmed : null;
}

interface RenderContext {
	prefix: string;
}

function inline(tokens: Token[] | undefined, ctx: RenderContext): ComponentChildren[] {
	if (!tokens) return [];
	return tokens.map((token, index) => renderInlineToken(token, `${ctx.prefix}-${index}`));
}

function renderInlineToken(token: Token, key: string): ComponentChildren {
	switch (token.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? <span key={key}>{inline(text.tokens, { prefix: key })}</span> : text.text;
		}
		case "escape":
			return (token as Tokens.Escape).text;
		case "strong":
			return (
				<strong key={key} class="font-semibold text-base-content">
					{inline((token as Tokens.Strong).tokens, { prefix: key })}
				</strong>
			);
		case "em":
			return <em key={key}>{inline((token as Tokens.Em).tokens, { prefix: key })}</em>;
		case "del":
			return (
				<del key={key} class="opacity-60">
					{inline((token as Tokens.Del).tokens, { prefix: key })}
				</del>
			);
		case "codespan":
			return (
				<code key={key} class="rounded bg-base-300/70 px-1 py-0.5 font-mono text-[0.9em]">
					{(token as Tokens.Codespan).text}
				</code>
			);
		case "br":
			return <br key={key} />;
		case "link": {
			const link = token as Tokens.Link;
			const href = safeHref(link.href);
			const label = inline(link.tokens, { prefix: key });
			if (!href) return <span key={key}>{label}</span>;
			return (
				<a
					key={key}
					href={href}
					target="_blank"
					rel="noreferrer noopener"
					title={link.title ?? href}
					class="link link-primary break-all"
				>
					{label}
				</a>
			);
		}
		case "image": {
			const image = token as Tokens.Image;
			const src = safeHref(image.href);
			if (!src) return image.text;
			return (
				<a key={key} href={src} target="_blank" rel="noreferrer noopener" class="inline-block">
					<img
						src={src}
						alt={image.text}
						loading="lazy"
						class="my-1 max-h-72 max-w-full rounded-box border border-base-300"
					/>
				</a>
			);
		}
		case "html":
			// Raw HTML stays inert: it is shown as text, never parsed.
			return <span key={key} class="font-mono text-[0.9em] opacity-70">{(token as Tokens.HTML).text}</span>;
		default: {
			const fallback = token as { text?: string; tokens?: Token[] };
			if (fallback.tokens) return <span key={key}>{inline(fallback.tokens, { prefix: key })}</span>;
			return fallback.text ?? "";
		}
	}
}

function alignmentStyle(align: string | null | undefined): string | undefined {
	if (align === "center") return "text-center";
	if (align === "right") return "text-right";
	if (align === "left") return "text-left";
	return undefined;
}

function renderBlockToken(token: Token, key: string): ComponentChildren {
	switch (token.type) {
		case "space":
			return null;
		case "code": {
			const code = token as Tokens.Code;
			return <CodeBlock key={key} language={code.lang ?? ""} code={code.text} />;
		}
		case "heading": {
			const heading = token as Tokens.Heading;
			const body = inline(heading.tokens, { prefix: key });
			const cls = "mt-3 mb-1 font-semibold first:mt-0";
			if (heading.depth === 1) return <h1 key={key} class={`${cls} text-lg`}>{body}</h1>;
			if (heading.depth === 2) return <h2 key={key} class={`${cls} text-base`}>{body}</h2>;
			if (heading.depth === 3) return <h3 key={key} class={`${cls} text-[0.95rem]`}>{body}</h3>;
			return <h4 key={key} class={`${cls} text-sm uppercase tracking-wide opacity-80`}>{body}</h4>;
		}
		case "paragraph":
			return (
				<p key={key} class="my-1.5 first:mt-0 last:mb-0">
					{inline((token as Tokens.Paragraph).tokens, { prefix: key })}
				</p>
			);
		case "blockquote":
			return (
				<blockquote
					key={key}
					class="my-2 border-l-2 border-base-300 pl-3 text-[0.95em] leading-relaxed opacity-85"
				>
					{renderBlocks((token as Tokens.Blockquote).tokens, { prefix: key })}
				</blockquote>
			);
		case "list": {
			const list = token as Tokens.List;
			const items = list.items.map((item, index) => renderBlockToken(item, `${key}-${index}`));
			const cls = list.ordered
				? "my-1.5 list-decimal space-y-0.5 pl-5 marker:text-base-content/40"
				: "my-1.5 list-disc space-y-0.5 pl-5 marker:text-base-content/40";
			return list.ordered ? (
				<ol key={key} start={typeof list.start === "number" ? list.start : undefined} class={cls}>
					{items}
				</ol>
			) : (
				<ul key={key} class={cls}>
					{items}
				</ul>
			);
		}
		case "checkbox":
			// Rendered by the owning list item, which knows the task state.
			return null;
		case "list_item": {
			const item = token as Tokens.ListItem;
			const box = item.tokens.find((child) => child.type === "checkbox") as
				| { checked?: boolean }
				| undefined;
			const isTask = item.task === true || box !== undefined;
			const checkbox = isTask ? (
				<input
					type="checkbox"
					disabled
					checked={box?.checked ?? item.checked ?? false}
					class="checkbox checkbox-xs mr-1.5 -mt-0.5 align-middle"
				/>
			) : null;
			const content = item.tokens.filter((child) => child.type !== "checkbox");
			// Marked wraps loose list items in a paragraph; render a lone leading
			// paragraph inline so bullets and task checkboxes stay on one line.
			const [first] = content;
			const lead = first && (first.type === "text" || first.type === "paragraph") ? first : undefined;
			const rest = lead ? content.slice(1) : content;
			const body = (
				<>
					{lead ? inline((lead as Tokens.Text).tokens, { prefix: key }) : null}
					{renderBlocks(rest, { prefix: `${key}-rest` })}
				</>
			);
			return (
				<li key={key} class={item.task === true ? "list-none pl-0" : "pl-0.5"}>
					{checkbox}
					{body}
				</li>
			);
		}
		case "table": {
			const table = token as Tokens.Table;
			const head = table.header.map((cell, index) => (
				<th key={`${key}-h-${index}`} class={`font-semibold ${alignmentStyle(cell.align) ?? ""}`}>
					{inline(cell.tokens, { prefix: `${key}-h-${index}` })}
				</th>
			));
			const body = table.rows.map((row, rowIndex) => (
				<tr key={`${key}-r-${rowIndex}`}>
					{row.map((cell, cellIndex) => (
						<td key={`${key}-r-${rowIndex}-c-${cellIndex}`} class={alignmentStyle(cell.align) ?? ""}>
							{inline(cell.tokens, { prefix: `${key}-r-${rowIndex}-c-${cellIndex}` })}
						</td>
					))}
				</tr>
			));
			return (
				<div key={key} class="my-2 overflow-x-auto">
					<table class="table table-xs">
						<thead>
							<tr>{head}</tr>
						</thead>
						<tbody>{body}</tbody>
					</table>
				</div>
			);
		}
		case "hr":
			return <hr key={key} class="my-3 border-base-300" />;
		case "html":
			return (
				<pre key={key} class="my-1 font-mono text-[0.9em] opacity-70">
					{(token as Tokens.HTML).text}
				</pre>
			);
		case "text": {
			const text = token as Tokens.Text;
			// Loose list items wrap their content in `text` tokens.
			if (text.tokens) {
				return (
					<p key={key} class="my-1 first:mt-0 last:mb-0">
						{inline(text.tokens, { prefix: key })}
					</p>
				);
			}
			return text.text;
		}
		default:
			return renderInlineToken(token, key);
	}
}

function renderBlocks(tokens: Token[] | undefined, ctx: RenderContext): ComponentChildren[] {
	if (!tokens) return [];
	return tokens.map((token, index) => renderBlockToken(token, `${ctx.prefix}-${index}`));
}

interface CodeBlockProps {
	language: string;
	code: string;
}

function renderHighlightTokens(tokens: readonly HighlightToken[], prefix: string): ComponentChildren[] {
	return tokens.map((token, index) => {
		if (typeof token === "string") return token;
		return (
			<span key={`${prefix}-${index}`} class={`hljs-${token.kind}`}>
				{renderHighlightTokens(token.children, `${prefix}-${index}`)}
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
					{renderHighlightTokens(tokens, "hl")}
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

/**
 * Markdown renderer for agent output: headings, lists (with task lists),
 * tables, quotes, links, images and highlighted fenced code. Tokens are turned
 * into elements directly, so raw HTML in a transcript can never become markup.
 */
export function MarkdownText({ text, className = "" }: MarkdownTextProps) {
	const source = typeof text === "string" ? text : "";
	const capped = source.length > MAX_CHARS ? `${source.slice(0, MAX_CHARS)}\n\n…truncated` : source;
	const blocks = useMemo(() => {
		if (!capped.trim()) return [];
		try {
			return renderBlocks(marked.lexer(capped), { prefix: "md" });
		} catch {
			return [<p key="fallback">{capped}</p>];
		}
	}, [capped]);
	return <div class={`wrap-anywhere ${className}`} data-testid="markdown">{blocks}</div>;
}
