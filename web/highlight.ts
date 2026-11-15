import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
	bash,
	css,
	diff,
	go,
	javascript,
	json,
	markdown,
	python,
	rust,
	sql,
	typescript,
	xml,
	yaml,
} as const;

type LanguageName = keyof typeof LANGUAGES;

const ALIASES: Record<string, LanguageName> = {
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	console: "bash",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	node: "javascript",
	ts: "typescript",
	tsx: "typescript",
	types: "typescript",
	py: "python",
	rb: "python",
	yml: "yaml",
	html: "xml",
	svg: "xml",
	vue: "xml",
	md: "markdown",
	golang: "go",
	rs: "rust",
	postgres: "sql",
	postgresql: "sql",
	"c++": "rust",
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
	hljs.registerLanguage(name, definition);
}

/** Registered language names, for the docs and the UI. */
export const HIGHLIGHT_LANGUAGES: readonly string[] = Object.keys(LANGUAGES);

export type HighlightToken = string | { kind: string; children: HighlightToken[] };

function resolveLanguage(language: string): LanguageName | null {
	const key = language.trim().toLowerCase();
	if (!key) return null;
	if (key in LANGUAGES) return key as LanguageName;
	return ALIASES[key] ?? null;
}

function toTokens(nodes: readonly unknown[]): HighlightToken[] {
	const tokens: HighlightToken[] = [];
	for (const node of nodes) {
		if (typeof node === "string") {
			tokens.push(node);
			continue;
		}
		if (!node || typeof node !== "object") continue;
		const record = node as { kind?: unknown; children?: unknown };
		if (typeof record.kind !== "string" || !Array.isArray(record.children)) continue;
		tokens.push({ kind: record.kind, children: toTokens(record.children) });
	}
	return tokens;
}

/**
 * Highlight a fenced code block into a token tree, so the caller can render it
 * as text nodes and spans. Nothing here produces HTML, which keeps untrusted
 * model output out of any innerHTML path.
 */
export function highlightTokens(code: string, language: string): HighlightToken[] {
	const resolved = resolveLanguage(language);
	if (!resolved) return [code];
	try {
		const result = hljs.highlight(code, { language: resolved, ignoreIllegals: true });
		// highlight.js exposes the parsed token tree as `_top` (the HTML `value` is
		// deliberately unused so model output never reaches an innerHTML sink).
		const tree = (result as unknown as { _top?: readonly unknown[] })._top;
		return toTokens(tree ?? []);
	} catch {
		return [code];
	}
}
