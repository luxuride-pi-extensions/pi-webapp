#!/usr/bin/env node
/**
 * Build pipeline for pi-webapp.
 *
 *  1. src/  -> dist/      (tsc, ESM, source maps)
 *  2. web/  -> dist/web/  (Tailwind + daisyUI CSS, esbuild JS bundle, index.html)
 *
 * The extension itself is loaded from src/index.ts by pi (jiti), but the
 * dashboard assets must exist on disk before the server can serve them.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const distWeb = path.join(distDir, "web");
const bin = (name) => path.join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

function run(command, args, label) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(`[build] ${label} failed: ${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`[build] ${label} exited with code ${result.status}`);
		process.exit(result.status ?? 1);
	}
}

mkdirSync(distWeb, { recursive: true });

// 1. Backend TypeScript.
run(bin("tsc"), ["-p", "tsconfig.build.json"], "tsc");

// 2. Styles: Tailwind CSS v4 + daisyUI plugin, compiled by the official CLI.
const tailwind = bin("tailwindcss");
if (existsSync(tailwind) && existsSync(path.join(root, "web", "styles.css"))) {
	run(
		tailwind,
		["-i", path.join("web", "styles.css"), "-o", path.join("dist", "web", "app.css"), "--minify"],
		"tailwindcss",
	);
} else {
	console.error("[build] web/styles.css or the tailwindcss CLI is missing; dashboard will be unstyled");
	process.exit(1);
}

// 3. Frontend bundle.
await esbuild({
	entryPoints: [path.join(root, "web", "main.tsx")],
	outfile: path.join(distWeb, "app.js"),
	bundle: true,
	format: "esm",
	platform: "browser",
	target: ["es2020"],
	jsx: "automatic",
	jsxImportSource: "preact",
	minify: true,
	sourcemap: true,
	define: { "process.env.NODE_ENV": '"production"' },
	logLevel: "info",
});

// 4. Static shell.
copyFileSync(path.join(root, "web", "index.html"), path.join(distWeb, "index.html"));
for (const asset of ["favicon.svg", "favicon.ico", "robots.txt"]) {
	const source = path.join(root, "web", asset);
	if (existsSync(source)) copyFileSync(source, path.join(distWeb, asset));
}

// 5. Drop stale build artifacts (backend maps left over from removed files).
for (const entry of readdirSync(distDir)) {
	const full = path.join(distDir, entry);
	if (entry === "web") continue;
	if (statSync(full).isDirectory()) continue;
	if (entry.endsWith(".map") && entry.startsWith("web")) rmSync(full, { force: true });
}

console.log(`[build] done -> ${path.relative(root, distWeb)} (web) + ${path.relative(root, distDir)} (backend)`);
