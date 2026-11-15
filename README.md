# pi-wabapp

A browser dashboard for [pi](https://github.com/earendil-works/pi) coding-agent sessions. Watch your agent work live: every prompt, tool call and assistant message; a subagent tree for work delegated in-process or in separate `pi` processes; work-state screenshots and Playwright recordings with instant video scrubbing; and a prompt box that steers the running agent — all from a single local URL, `http://127.0.0.1:8787`.

`pi-wabapp` is a pi extension. It loads with `pi`, starts (or joins) a small loopback web server, and turns the session files that pi already writes into a live dashboard. Nothing is sent off the machine.

## Features

- **Live activity feed** — prompts, assistant messages, tool calls and errors stream over WebSocket as they happen, with a bounded in-memory history of the last 4000 events.
- **Subagent trees** — out-of-process subagents (child `pi` processes) and in-process tool subagents (`subagent`, `Agent`, `SubagentWorkflow`, `Task`) are grouped under the session that spawned them, with task text, status, duration and summary.
- **Artifact cache** — screenshots and recordings passed to `post_work_state` are copied into `~/.pi/cache/pi-wabapp/<sessionId>/` and served from `/artifacts/...`, so the feed keeps working after `/tmp` is cleaned up.
- **Range video streaming** — Playwright `.webm` recordings are served with HTTP `Range` support, so the browser can seek without downloading the whole clip.
- **Multi-instance dashboard** — run several `pi` processes at once; the first one binds `8787`, the rest register as instances and route prompts over the WebSocket.
- **Session leeching** — pi sessions started *without* the extension (plain CLI runs, older versions) are tailed straight from `~/.pi/agent/sessions` and appear as read-only feed entries.
- **Agent tools** — two tools agents can call on their own: `post_work_state` (milestone + screenshot/recording) and `capture_playwright_snapshot` (headless browser screenshot of a dev server).
- **Local-first UI** — Preact frontend, Tailwind CSS v4 and daisyUI, dark by default, no external fonts, scripts or telemetry.
- **No built-in auth, by design** — the server binds loopback only. Exposing it beyond your machine is your call; see [Security](#security) and [Running behind a reverse proxy](#running-behind-a-reverse-proxy).

## Install

### From git

```bash
pi install git:github.com/luxuride-pi-extensions/pi-wabapp
```

### From a local checkout

```bash
# install into your pi config
pi install ./path/to/pi-webapp

# or try it without installing
pi -e ./path/to/pi-webapp
```

Requires **Node.js >= 22.19**. Published packages ship compiled assets in `dist/`, so you only need a build when working on the source (see [Build from source](#build-from-source)).

### Quick start

```bash
pi
```

Start a session or send it a prompt, then open **http://127.0.0.1:8787** in a browser.

## Build from source

```bash
npm install
npm run build      # tsc -> dist/, Tailwind -> dist/web/app.css, esbuild -> dist/web/app.js
npm run typecheck  # tsc --noEmit
npm test           # end-to-end smoke test (needs a build first)
```

`npm run build` produces:

| Output | Contents |
| --- | --- |
| `dist/*.js` | Backend modules (ESM + source maps) — the server, storage, leech and pi extension bridge |
| `dist/web/app.js` | Preact dashboard bundle (esbuild, minified) |
| `dist/web/app.css` | Tailwind CSS v4 + daisyUI stylesheet |
| `dist/web/index.html` | Static shell |

The build pipeline lives in `scripts/build.mjs`: TypeScript via `tsc -p tsconfig.build.json`, styles via the `@tailwindcss/cli` binary, the frontend via `esbuild`. The extension entry point stays in `src/index.ts` (pi loads TypeScript through jiti); only the dashboard assets must exist on disk before the server can serve them.

## Configuration

All configuration is environment based — there are no CLI flags.

| Variable | Default | Description |
| --- | --- | --- |
| `PI_WABAPP_PORT` | `8787` | Port for the dashboard server. `0` picks a free ephemeral port. |
| `PI_WABAPP_HOST` | `127.0.0.1` | Bind address. Keep the loopback default unless a proxy fronts the server. |
| `PI_WABAPP_CACHE_DIR` | `~/.pi/cache/pi-wabapp` | Artifact cache root (one subdirectory per session). |
| `PI_WABAPP_LEECH` | `1` | `0` disables session leeching entirely. |
| `PI_WABAPP_LEECH_DIR` | `~/.pi/agent/sessions` | Colon-separated list of session directories to tail. |
| `PI_WABAPP_PLAYWRIGHT` | *(auto-detected)* | Path to the Playwright CLI used by `capture_playwright_snapshot`. |
| `PI_WABAPP_PARENT_SESSION_ID` | *(set by the extension)* | Parent session id handed to a spawned child `pi` process. |
| `PI_WABAPP_AGENT_NAME` | *(set by the extension)* | Subagent name handed to a spawned child `pi` process. |

Examples:

```bash
# move the dashboard to another port
PI_WABAPP_PORT=9000 pi

# keep the dashboard, disable session leeching
PI_WABAPP_LEECH=0 pi

# tail extra session directories (colon separated)
PI_WABAPP_LEECH_DIR="$HOME/.pi/agent/sessions:$HOME/work/app/.pi/sessions" pi

# keep artifacts somewhere with more room
PI_WABAPP_CACHE_DIR=/var/tmp/pi-wabapp pi
```

## Tools

The extension registers two tools. They are what make the dashboard more than a log viewer.

### `post_work_state`

Publishes a milestone to the dashboard: a title, optional notes, and optionally a screenshot and/or a recording. Media paths are validated and copied into the cache; the event bubbles into the parent feed when the calling session is a subagent.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | yes | Short milestone summary, e.g. `"Login form validation fixed"`. |
| `description` | `string` | no | Notes / test summary shown under the title. |
| `screenshotPath` | `string` | no | Path to a `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif` image on disk. |
| `videoPath` | `string` | no | Path to a Playwright recording (`.webm`, `.mp4`, `.mov`). |
| `url` | `string` | no | Local dev server URL being tested, e.g. `http://localhost:3000`. |

The tool validates the paths, copies the media into `~/.pi/cache/pi-wabapp/<sessionId>/`, broadcasts a work-state event (with the session id, parent session id and agent name) and returns the viewer URL plus the absolute artifact URLs. Missing files, unsupported extensions and empty files are rejected with an explicit error.

Example tool call:

```json
{
  "tool": "post_work_state",
  "input": {
    "title": "Login form validation fixed",
    "description": "Empty and oversized inputs now show inline errors. 12/12 unit tests pass.",
    "screenshotPath": "/tmp/login-form.png",
    "videoPath": "/tmp/login-flow.webm",
    "url": "http://localhost:3000/login"
  }
}
```

### `capture_playwright_snapshot`

Takes a headless screenshot of a page and publishes it as work state. Useful when an agent is iterating on a dev server and wants to show the result without a human at the keyboard.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `targetUrl` | `string` | yes | `http`/`https` URL to capture. |
| `title` | `string` | yes | Milestone title for the resulting work state. |
| `fullPage` | `boolean` | no | Capture the full scrollable page (default `false` — viewport only). |
| `viewport` | `string` | no | Viewport size such as `"1280x720"` or `"390x844"` (default `1280x720`). |
| `description` | `string` | no | Notes attached to the work state. |

The tool shells out to the Playwright CLI (`playwright screenshot`, 120 s timeout), then hands the PNG to `post_work_state`. Install Playwright once:

```bash
npm i -D playwright && npx playwright install chromium
```

If Playwright is missing the tool fails gracefully with an install hint instead of crashing the session; set `PI_WABAPP_PLAYWRIGHT` when the CLI lives outside the project (`node_modules/.bin/playwright`).

Example prompt to your agent:

> Before you finish, start the dev server, call `capture_playwright_snapshot` on `http://localhost:3000` with the title "Checkout wired up", then call `post_work_state` with a summary of what changed.

## Subagent integration

Subagent activity is stitched back into the dashboard in three ways.

**Out-of-process subagents.** When a subagent tool launches a separate `pi` process, the extension injects environment variables at `tool_execution_start`:

- `PI_WABAPP_PARENT_SESSION_ID` — the spawning session
- `PI_WABAPP_AGENT_NAME` — the subagent name

Launchers that use the older variable names are supported too: `PI_PARENT_SESSION_ID` and `PI_SUBAGENT_NAME`. A child `pi` also detects its parent from the `parentSession` field in its session header, so the tree survives even when the environment was not propagated. The child then registers itself as a subagent and its events are attributed to the child session.

**In-process subagents.** Tool calls named `subagent`, `Agent`, `SubagentWorkflow` or `Task` are intercepted at their boundaries. A call becomes a `subagent_spawned` event on the parent session (data: `childSessionId`, `agentName`, `task`, `callId`) and its result becomes `subagent_completed` (data: `childSessionId`, `status`, `summary`, `durationMs`). No extra plumbing is needed in the subagent itself.

**Artifact attribution.** Screenshots and recordings published by a subagent are stored under the child session's cache directory, surfaced in the child's work-state panel, and echoed into the parent feed as `[subagent: name]` entries so the parent timeline still tells the whole story. The dashboard renders the hierarchy as a tree — parent at the root, children indented, each node with its own status dot, task text and media.

## Architecture

### File map

| Path | Responsibility |
| --- | --- |
| `src/protocol.ts` | Shared wire contract: event/session types, defaults, env names, helpers. Dependency-free so the browser bundle can import it. |
| `src/index.ts` | pi extension entry point: starts or joins the server, translates pi session events, registers tools, propagates subagent env. |
| `src/server.ts` | HTTP + WebSocket server: static assets, `/api/*`, artifact streaming with `Range`, prompt routing, instance registry. |
| `src/storage.ts` | Artifact cache helpers: `ingestArtifact` copies screenshots/recordings into the cache, MIME lookup, cache-root resolution and pruning. |
| `src/leech.ts` | Tails pi session JSONL files and replays them as read-only `leech` sessions. |
| `src/bridge.ts` | Startup glue: boots a `WabappServer` when the port is free, otherwise joins the existing primary through `WabappClient`; wires the prompt handler and artifact pruning. |
| `src/client.ts` | Client used by secondary instances to talk to the primary server (instance socket, command ack). |
| `src/tools.ts` | `post_work_state` and `capture_playwright_snapshot` tool definitions. |
| `web/main.tsx`, `web/*` | Preact dashboard: feed, subagent tree, work-state panel, prompt box. |
| `scripts/build.mjs` | Build pipeline (tsc, Tailwind CLI, esbuild, static shell). |

### Request and event flow

Primary flow — the `pi` process that owns the dashboard:

```
pi session ──events──▶ bridge.ts ──POST /api/events──▶ server.ts ──▶ storage.ts
                                                            │
browser ──WS /ws──▶ snapshot + event stream ◀───────────────┘
browser ──POST /api/sessions/:id/prompt──▶ local prompt handler ──▶ pi session
```

Secondary flow — additional `pi` processes:

```
pi #2 ──WS /ws?role=instance&instanceId=…──▶ primary server
      ◀── {type:"command"} ── prompt for a session owned by this instance
      ──▶ {type:"command_ack"} ── accepted/rejected
```

### WebSocket messages

One endpoint, `/ws`, two roles.

Server → client: `snapshot` (full state on connect), `event`, `session`, `command`, `hello_ok`, `pong`.
Client → server: `hello` (`role: "ui" | "instance"`, optional `instanceId`), `command_ack`, `ping`.

### HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/state` | Full dashboard state: sessions, recent events, counts, leech status. |
| `GET` | `/api/health` | Liveness probe, `{ "ok": true }`. |
| `POST` | `/api/events` | Ingest an event: `{ instanceId, event }`. Used by instances and the extension. |
| `POST` | `/api/sessions/:sessionId/prompt` | Send a prompt to a session. `200 { ok, delivered: "local" }`, `202` when routed to another instance, `409` for leech-only sessions, `404` for unknown ids. |
| `GET` | `/api/leech` | Leech status: `enabled`, `running`, `dirs`, `files`, `sessions`, `lastScanAt`, `lastError`. |
| `POST` | `/api/leech/scan` | Force a rescan of the configured session directories. |
| `GET`/`HEAD` | `/artifacts/<sessionId>/<filename>` | Artifact download with `Accept-Ranges: bytes`; partial requests answer `206`/`416`. |

Dashboard assets are served from `dist/web/` at `/`, `/app.js` and `/app.css`.

### Artifact cache layout

```
~/.pi/cache/pi-wabapp/
└── <sessionId>/
    ├── m9x2k1-7f3a-login-form.png
    └── m9x2k1-91bd-login-flow.webm
```

Files are named `<timestamp base36>-<random>-<safe original name>`, which keeps uploads from different ticks unique and prevents path tricks in the original filename. Each artifact is capped at 512 MiB (`MAX_MEDIA_BYTES`); ingestion rejects missing, empty and oversized files as well as unsupported extensions.

## Multi-instance setups

Run as many `pi` processes as you like; they cooperate around one dashboard:

- **Election** — the first process to bind `PI_WABAPP_PORT` becomes the primary and owns the server. Later processes find the port taken, connect to the primary as an instance and keep working.
- **Prompt routing** — the server tracks which instance owns each session. A prompt for a session owned by the primary goes to the local handler (`delivered: "local"`); a prompt for a session owned by another instance is pushed as a `command` over that instance's socket (`202`, `delivered: "instance"`) and acknowledged with `command_ack`.
- **Leeching** — sessions run without the extension still show up when their project directory is covered by `PI_WABAPP_LEECH_DIR`. Leech sessions are read-only: prompting one answers `409`, because there is no live process to steer.

The dashboard does not care which process is primary — the browser always talks to `http://127.0.0.1:8787`.

## Security

`pi-wabapp` is a local developer tool and deliberately ships without accounts, sessions or tokens.

- **Loopback by default.** `PI_WABAPP_HOST=127.0.0.1` means only the local machine can reach the dashboard, and browsers on other machines cannot.
- **No login by design.** Anyone who can reach the port can read your transcripts, download artifacts and send prompts to your agents. Treat the port as equivalent to your shell.
- **Path traversal protection.** Artifact URLs are resolved and checked against the artifacts root; encoded traversal attempts (`..%2f..%2fetc/passwd`) are rejected with `400`/`403`/`404` and never leak files outside the cache.
- **Artifact caps.** Uploads are validated by extension and size (512 MiB ceiling) and stored under generated names, so a session cannot overwrite arbitrary files in the cache.
- **Threat model.** Trusted local user on a trusted machine. If you need remote access, put an authenticating proxy in front (next section) and keep the origin on loopback. `PI_WABAPP_HOST=0.0.0.0` exposes read *and* write access to every reachable network — it is unsafe without that proxy.

## Running behind a reverse proxy

WebSocket upgrades and `Range` requests must reach the origin untouched. Terminate TLS and authenticate at the proxy, and keep `PI_WABAPP_HOST=127.0.0.1`.

### Caddy

```caddyfile
dashboard.example.com {
	basic_auth {
		alice $2a$14$replace.with.a.real.bcrypt.hash
	}

	reverse_proxy 127.0.0.1:8787 {
		header_up Host {host}
	}
}
```

Caddy upgrades WebSocket connections automatically; `header_up Host {host}` keeps the origin's `Origin`/`Host` checks sane.

### Nginx

```nginx
server {
	listen 443 ssl;
	server_name dashboard.example.com;

	# Playwright recordings are served from disk, not uploaded, but keep
	# request bodies small — the dashboard only sends JSON prompts.
	client_max_body_size 4m;

	location / {
		auth_basic "pi-wabapp";
		auth_basic_user_file /etc/nginx/.htpasswd;

		proxy_pass http://127.0.0.1:8787;
		proxy_http_version 1.1;

		# WebSocket upgrade for /ws
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_set_header Host $host;

		# Keep idle sockets alive; the dashboard reconnects otherwise.
		proxy_read_timeout 3600s;
		proxy_send_timeout 3600s;
	}
}
```

Nginx forwards `Range` headers by default, so video scrubbing keeps working through the proxy. If you add `proxy_cache`, make sure `206` responses are not cached as complete files.

### Tailscale

```bash
tailscale serve --bg 8787
```

This publishes the dashboard to your tailnet over HTTPS with Tailscale identity in front of it. The server keeps listening on loopback.

> **Warning:** binding the dashboard to `0.0.0.0` and exposing it directly — port forwarding, a public cloud firewall rule, `tailscale funnel` — is unsafe without authentication. Use one of the proxies above.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `EADDRINUSE` on start | Another `pi` already owns the port. Instances join it automatically; the message is informational. Change `PI_WABAPP_PORT` if you want a separate dashboard. |
| Blank dashboard | Assets are missing: run `npm run build` (or reinstall the package). Check that `dist/web/app.js`, `dist/web/app.css` and `dist/web/index.html` exist. |
| Video will not scrub | A proxy is stripping `Range`. Verify `curl -sI -H 'Range: bytes=0-1' http://127.0.0.1:8787/artifacts/<id>/<file>.webm` answers `206` with `Content-Range`. |
| `capture_playwright_snapshot` fails | Playwright not installed: `npm i -D playwright && npx playwright install chromium`. Set `PI_WABAPP_PLAYWRIGHT` if the CLI is elsewhere. |
| Subagents missing from the tree | Restart `pi` so the extension reloads, and check that the launcher passes `PI_WABAPP_PARENT_SESSION_ID`/`PI_WABAPP_AGENT_NAME` (or the legacy `PI_PARENT_SESSION_ID`/`PI_SUBAGENT_NAME`). In-process subagent tools are detected by name — custom wrappers are not. |
| Leech list is empty | `PI_WABAPP_LEECH=0` disables it; make sure `PI_WABAPP_LEECH_DIR` points at the directories that actually contain `*.jsonl` session files, then `POST /api/leech/scan`. |
| Prompt returns `409` | The session is leeched (read-only). Start the session through `pi` with the extension to steer it. |
| Prompt returns `404` | Unknown session id — the dashboard has not seen that session yet. |

## Development

```
pi-webapp/
├── src/                  extension + server (TypeScript, ESM)
├── web/                  Preact dashboard (Tailwind v4 + daisyUI)
├── scripts/build.mjs     tsc, Tailwind CLI, esbuild, static shell
├── tests/smoke.mjs       end-to-end smoke test
├── dist/                 build output (shipped with the package)
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

Commands:

```bash
npm run build      # compile backend + dashboard
npm run typecheck  # strict TypeScript check, no emit
npm run check      # typecheck + syntax-check the dashboard bundle
npm test           # smoke test (requires a build)
```

`npm test` boots a real server on an ephemeral loopback port and walks the public contract: static assets, event ingestion, WebSocket snapshot and broadcast, `Range` streaming (206/416/traversal rejection), prompt routing (local, instance, leech, unknown) and leech tailing of a session file. It writes only to a temporary directory and exits non-zero on the first failing step, naming it.

Contributions: keep `src/protocol.ts` dependency-free (the browser imports it), add a step to `tests/smoke.mjs` for new wire behaviour, and run `npm run check` before sending a patch.

## License

MIT © 2026 luxuride-pi-extensions. See [LICENSE](LICENSE).
