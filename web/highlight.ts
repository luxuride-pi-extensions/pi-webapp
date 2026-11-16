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
		const record = node as { scope?: unknown; children?: unknown };
		// highlight.js nodes carry their class name in `scope` (e.g. "title function_").
		if (typeof record.scope !== "string" || !Array.isArray(record.children)) continue;
		tokens.push({ kind: record.scope, children: toTokens(record.children) });
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
		// Walk the emitter's token tree: the HTML `value` is deliberately unused so
		// model output never reaches an innerHTML sink.
		// SAFETY: highlight.js types hide the emitter, but the runtime result always
		// carries `_emitter.rootNode.children` (strings and `{ scope, children }`).
		const emitter = (result as unknown as { _emitter?: { rootNode?: { children?: readonly unknown[] } } })._emitter;
		return toTokens(emitter?.rootNode?.children ?? []);
	} catch {
		return [code];
	}
}

/** ANSI styling a CLI wrote into its output; the browser should not show escapes. */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export interface OutputShape {
	/** Text with terminal escapes removed. */
	text: string;
	/** Language to highlight with, or null when the output is plain prose. */
	language: string | null;
	/** Short badge for the output header ("diff", "json", "text", …). */
	label: string;
}

const EXTENSION_ALIASES: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascript",
	json: "json",
	py: "python",
	rs: "rust",
	go: "go",
	yml: "yaml",
	yaml: "yaml",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	css: "css",
	html: "xml",
	xml: "xml",
	svg: "xml",
	md: "markdown",
	diff: "diff",
	patch: "diff",
};

function languageFromHint(hint: string): string | null {
	const matches = hint.match(/[\w/.-]+\.[a-z0-9]{1,5}\b/gi);
	if (!matches) return null;
	for (const match of matches.reverse()) {
		const extension = match.slice(match.lastIndexOf(".") + 1).toLowerCase();
		const language = EXTENSION_ALIASES[extension];
		if (language) return language;
	}
	return null;
}

/**
 * Guess what a tool wrote, so output is highlighted by content rather than by
 * whichever tool produced it. The command is only a hint: `git diff` and
 * `npx playwright test` both print very different shapes.
 */
export function detectOutput(raw: string, hint = ""): OutputShape {
	const text = stripAnsi(raw);
	const trimmed = text.trim();
	if (!trimmed) return { text, language: null, label: "text" };

	if (/^(diff --git |index [0-9a-f]+\.\.|--- a\/|\+\+\+ b\/|@@ )/m.test(trimmed) || /\n@@ [^\n]*@@/.test(trimmed)) {
		return { text, language: "diff", label: "diff" };
	}
	if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
		try {
			JSON.parse(trimmed);
			return { text, language: "json", label: "json" };
		} catch {
			// not JSON, keep looking
		}
	}
	if (/^(<\?xml|<!DOCTYPE|<[a-z][\w-]*(?:[\s>]|$))/i.test(trimmed) && /<\/[a-z]/i.test(trimmed)) {
		return { text, language: "xml", label: "xml" };
	}
	if (/Traceback \(most recent call last\)/.test(trimmed)) return { text, language: "python", label: "python" };
	if (/(^|\n)\s+at\s+[\w$.<>]+\s*\([^)]*:\d+:\d+\)/.test(trimmed) || /(^|\n)\s+at\s+[\w$.<>]+:\d+:\d+/.test(trimmed)) {
		return { text, language: "javascript", label: "stack" };
	}
	const lines = trimmed.split("\n");
	if (lines.length > 2) {
		const yamlish = lines.filter((line) => /^[\w.-]+:\s+\S/.test(line)).length;
		if (yamlish >= Math.max(2, Math.ceil(lines.length * 0.6))) return { text, language: "yaml", label: "yaml" };
	}
	// Test-runner and CLI logs talk about code without being code.
	if (/(^|\n)\s*(Error|FAIL|error):?\s/.test(trimmed) && !/^\s*[}{[]/m.test(trimmed)) {
		return { text, language: null, label: "log" };
	}
	const fromHint = languageFromHint(hint);
	if (fromHint === "diff") return { text, language: "diff", label: "diff" };
	if (fromHint && lines.length > 2) return { text, language: fromHint, label: fromHint };
	if (lines.length > 1 && lines.every((line) => line.startsWith("$ ") || line.startsWith("> "))) {
		return { text, language: "bash", label: "shell" };
	}
	if (fromHint) return { text, language: fromHint, label: fromHint };
	return { text, language: null, label: "text" };
}
