# pi-webapp

A browser dashboard for [pi](https://github.com/earendil-works/pi) coding-agent sessions. Watch your agent work live: every prompt, tool call and assistant message; a subagent tree for work delegated in-process or in separate `pi` processes; work-state screenshots and Playwright recordings with instant video scrubbing; and a prompt box that steers the running agent — all from a single local URL, `http://127.0.0.1:8787`.

`pi-webapp` is a pi extension — and a standalone dashboard daemon. As an extension it loads with `pi`, starts (or joins) a small loopback web server, and turns the session files that pi already writes into a live dashboard. As a daemon (`pi-webapp serve`) the same dashboard runs without any `pi` process, keeps serving history and can start new sessions itself. Nothing is sent off the machine.

## Features

- **Live activity feed** — prompts, assistant messages, tool calls and errors stream over WebSocket as they happen, with a bounded in-memory history of the last 4000 events.
- **Subagent trees** — out-of-process subagents (child `pi` processes) and in-process tool subagents (`subagent`, `Agent`, `SubagentWorkflow`, `Task`) are grouped under the session that spawned them, with task text, status, duration and summary.
- **Artifact cache** — screenshots and recordings passed to `post_work_state` are copied into `~/.pi/cache/pi-webapp/<sessionId>/` and served from `/artifacts/...`, so the feed keeps working after `/tmp` is cleaned up.
- **Range video streaming** — Playwright `.webm` recordings are served with HTTP `Range` support, so the browser can seek without downloading the whole clip.
- **Multi-instance dashboard** — run several `pi` processes at once; the first one binds `8787`, the rest register as instances and route prompts over the WebSocket.
- **Standalone daemon** — `pi-webapp serve` runs the dashboard without a `pi` process: always-on, leeching session files, accepting `pi` instances as they join, and starting new sessions from the browser.
- **Autostart** — installing the package registers a systemd user service (falling back to the first `pi` run when npm skips install scripts), so the dashboard is already up at login and keeps running after every `pi` exits.
- **Session leeching** — pi sessions started *without* the extension (plain CLI runs, older versions) are tailed straight from `~/.pi/agent/sessions` and appear as read-only feed entries. Transcripts are only picked up when they are recent or owned by a running `pi` process, so a directory full of finished sessions stays quiet.
- **Navigation and focus** — every session has a deep link (`#/s/<sessionId>`), the sidebar has a filter box and status chips, and a sticky **expand all** toggle opens the whole tree (persisted per browser).
- **Separate subagent output** — subagents report into their own right-hand rail with live status and their latest message, so their turn-by-turn chatter no longer interleaves with the main agent's feed. The parent feed keeps the spawn/completion cards and any `post_work_state` they post.
- **Take over and remove** — a leeched session can be resumed in a fresh `pi` process (`pi --session <file>`) and prompted from the browser; sessions can be removed from the dashboard, optionally deleting their transcript. Subagents are never taken over.
- **Readable transcripts** — code blocks are syntax-highlighted (highlight.js tokens rendered as elements, never as HTML) with a copy button, and long tool output is wrapped full-width instead of squeezing the command name.
- **Model switching** — the session header lists the models the owning `pi` instance has authenticated and switches the session through `pi.setModel`, so a dashboard prompt can continue on a different model.
- **Extensible panels** — other `pi` extensions can inject their own panels into the dashboard (todo lists, pi-lens findings, anything) without touching this package: register a directory and the UI sandboxes its files in an iframe fed with the selected session's events. See [Plugins](#plugins).
- **Agent tools** — two tools agents can call on their own: `post_work_state` (milestone + screenshot/recording) and `capture_playwright_snapshot` (headless browser screenshot of a dev server).
- **Local-first UI** — Preact frontend, Tailwind CSS v4 and daisyUI, dark by default, no external fonts, scripts or telemetry.
- **No built-in auth, by design** — the server binds loopback only. Exposing it beyond your machine is your call; see [Security](#security) and [Running behind a reverse proxy](#running-behind-a-reverse-proxy).

## Install

```bash
pi install git:github.com/luxuride-pi-extensions/pi-webapp
```

One command, nothing else to build or configure. It registers the extension with `pi`, ships the compiled dashboard, and — on Linux with a systemd user session — **enables the always-on dashboard service**, so the dashboard is already running at your next login and every `pi` process joins it instead of starting a second server.

Requires **Node.js >= 22.19** and a `pi` with extension support (1.4 or newer).

### What installing does

| Step | Effect |
| --- | --- |
| Extension registration | `post_work_state` and `capture_playwright_snapshot` become available in every session, including subagents. |
| Dashboard | The first `pi` process serves `http://127.0.0.1:8787`; any further `pi` process joins it as an instance (primary/secondary election). |
| Autostart | `~/.config/systemd/user/pi-webapp.service` is written, enabled and started during the install by the package's own `postinstall` hook. If lifecycle scripts are suppressed (`--ignore-scripts`, CI images, a registry policy) or the unit was removed, the extension does the same on the next `session_start`. |
| Subagent tree | Child `pi` processes that inherit `PI_WEBAPP_PARENT_SESSION_ID` / `PI_WEBAPP_AGENT_NAME` (or a `parentSession` header) are grouped under their parent. |

Nothing is sent off the machine, there is no login screen, and the server is loopback-only unless you override `PI_WEBAPP_HOST`.

### After installing

```bash
pi                                  # start (or continue) a session
```

Open **http://127.0.0.1:8787** — or run `/webapp daemon status` inside `pi` for the URL, mode and whether the systemd service is enabled. To remove the autostart again: `/webapp daemon uninstall` (or `systemctl --user disable --now pi-webapp`). Details, logs and opt-outs: [Autostart](#autostart-systemd-user-service).

### Quick start

```bash
pi                                    # any session: the dashboard is already there
xdg-open http://127.0.0.1:8787         # or just open the URL in a browser
```

Send the agent a prompt and watch it work: prompts, tool calls, reasoning, subagents and posted screenshots appear in the feed as they happen, and the prompt box at the bottom steers the running session.

### Commands

Inside `pi`:

| Command | What it does |
| --- | --- |
| `/webapp` | Show the dashboard URL, primary/secondary mode and leech status. |
| `/webapp daemon start [port]` | Start a detached dashboard that keeps running after `pi` exits (default port from `PI_WEBAPP_PORT`, else `8787`). Prints the URL; safe to run twice. |
| `/webapp daemon status` | Is a daemon running, on which URL, with which pid. |
| `/webapp daemon stop` | Gracefully stop the daemon started by `pi-webapp` (pid file, `SIGTERM`, then `SIGKILL` after 6s). |
| `/webapp daemon install` | Write `~/.config/systemd/user/pi-webapp.service` for this install, enable it and start it (idempotent). |
| `/webapp daemon uninstall` | Disable, stop and delete the unit, and opt out of automatic setup until you install it again. |

## Standalone daemon

The extension only runs while a `pi` process is alive: no `pi`, no dashboard. The same server also ships as a standalone daemon, so the dashboard can be always-on — a systemd service, a tmux session, a machine you leave open — with no agent running. It serves the dashboard, tails session files, accepts `pi` processes as they join, and can start new sessions from the browser.

You do not need a PATH entry or a global install to use it:

```text
/webapp daemon start          # from inside pi — starts a detached dashboard on 8787
/webapp daemon start 9000     # ...or on another port, next to this pi's own dashboard
/webapp daemon stop           # stops the one pi-webapp started
```

Or run the CLI from the copy you already installed:

```bash
node ~/.pi/agent/git/github.com/luxuride-pi-extensions/pi-webapp/bin/pi-webapp.mjs serve
```

There is no registry package to `npx` — the name `pi-webapp` on npm belongs to an unrelated project — and you do not need a global install, because the installed copy is complete.

`serve` is optional: `pi-webapp` and `pi-webapp serve` are the same command. The daemon prints its URL and then serves until it is asked to stop:

```text
pi-webapp listening on http://127.0.0.1:8787
sessions can be started from the dashboard (pi)
```

On `SIGINT`, `SIGTERM` or `SIGHUP` it closes the WebSockets, kills the `pi` processes it started and frees the port. A daemon started from `pi` writes `~/.pi/cache/pi-webapp/daemon.pid` (or `$PI_WEBAPP_CACHE_DIR/daemon.pid`) and removes it on exit, which is what `/webapp daemon stop|status` reads. With no `pi` running it still serves the dashboard and leeches session files; any `pi` that loads the extension joins as a live instance (see [Multi-instance setups](#multi-instance-setups)).

| Flag | Default | Description |
| --- | --- | --- |
| `-p, --port <port>` | `$PI_WEBAPP_PORT` or `8787` | Port to listen on. `0` picks a free ephemeral port. |
| `--host <host>` | `$PI_WEBAPP_HOST` or `127.0.0.1` | Bind address. |
| `--cwd <dir>` | current directory | Default working directory for sessions started from the dashboard. |
| `--session-dir <dir>` | *(unset)* | `--session-dir` passed to every started session. |
| `--pi <path>` | `$PI_WEBAPP_PI_BIN` or `pi` | `pi` executable used for started sessions. |
| `--leech-dir <dir>` | `$PI_WEBAPP_LEECH_DIR` | Extra session directory to leech. Repeatable. |
| `--no-leech` | leeching on | Do not tail `pi` session files. |
| `--no-spawn` | spawning on for loopback | Do not allow sessions to be started from the dashboard. |
| `--wait` | off | Keep retrying instead of exiting while the port is busy (used by the systemd unit). |
| `--retry-ms <ms>` | `2000` | Delay between bind retries with `--wait`. |
| `-v, --version` | | Print the package version and exit. |
| `-h, --help` | | Print usage and exit. |

The daemon reads the same environment as extension mode (`PI_WEBAPP_PORT`, `PI_WEBAPP_HOST`, `PI_WEBAPP_CACHE_DIR`, `PI_WEBAPP_LEECH`, `PI_WEBAPP_LEECH_DIR`, `PI_WEBAPP_SPAWN`, `PI_WEBAPP_PI_BIN`, `PI_WEBAPP_SESSION_DIR`, `PI_WEBAPP_PLAYWRIGHT`); flags win over the environment.

### Autostart (systemd user service)

Installing the package enables an always-on dashboard; there is no extra command to run.

- **`pi install …` / `npm install`** → `scripts/postinstall.mjs` runs during the install, writes the unit, enables it, starts it, and prints `dashboard autostart enabled (…)` plus the URL.
- **Lifecycle scripts suppressed** (`--ignore-scripts`, CI images, a registry policy) → the extension performs the same convergence on the first `session_start`, so the first `pi` you run after installing reports the autostart and the unit appears.
- **`/webapp daemon install`** → same thing on demand, e.g. after changing the port or reinstalling.

From then on the service starts at login, restarts on failure, keeps the dashboard alive after `pi` exits, and every `pi` process (including subagents) joins it as a client instead of binding the port. If something already owns the port, the service runs `serve --wait` and takes the dashboard over as soon as the port frees up — no restart loop, no lost events.

```bash
systemctl --user status pi-webapp         # enabled/active state
journalctl --user -u pi-webapp -f         # dashboard logs
systemctl --user disable --now pi-webapp  # stop it, keep the unit
loginctl enable-linger "$USER"            # also start at boot, not only at login
```

| Command | Effect |
| --- | --- |
| `/webapp daemon install` | (Re)write the unit from the current install, enable and start it. |
| `/webapp daemon uninstall` | Disable, stop and delete the unit, then opt out: `~/.pi/cache/pi-webapp/autostart.json` remembers it so a later `pi` does not re-add it. |
| `/webapp daemon status` | Daemon plus systemd service state. |

Opting out without uninstalling: `PI_WEBAPP_AUTOSTART=0` disables both the postinstall and the `session_start` fallback. `PI_WEBAPP_SKIP_AUTOSTART=1` disables the postinstall only. `PI_WEBAPP_SYSTEMD_UNIT=name.service` overrides the unit name (tests use this).

The generated unit looks like this (paths and port come from the install):

```ini
[Unit]
Description=pi-webapp dashboard for pi coding-agent sessions
Documentation=https://github.com/luxuride-pi-extensions/pi-webapp
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/home/you
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PI_WEBAPP_HOST=127.0.0.1
Environment=PI_WEBAPP_PORT=8787
Environment=PI_WEBAPP_PI_BIN=/home/you/.pi/agent/bin/pi
ExecStart=/usr/bin/node /home/you/.pi/agent/git/github.com/luxuride-pi-extensions/pi-webapp/bin/pi-webapp.mjs serve --wait --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

**Not Linux / no systemd?** Autostart is skipped with a note (never an install failure). Run the same command under your own supervisor, for example launchd on macOS (`~/Library/LaunchAgents/com.example.pi-webapp.plist` with `ProgramArguments` of the `ExecStart` line above and `RunAtLoad`/`KeepAlive`), a Windows scheduled task, or a container entrypoint.

### tmux

```bash
tmux new-session -d -s pi-webapp \
  'node ~/.pi/agent/git/github.com/luxuride-pi-extensions/pi-webapp/bin/pi-webapp.mjs serve --cwd ~/projects'
tmux attach -t pi-webapp        # Ctrl-b d to detach again
```

### Starting sessions from the dashboard

With the dashboard up, the browser is enough to go from "nothing running" to an agent at work.

- **What runs.** The server launches `pi --mode rpc` in the requested working directory. RPC mode keeps the child alive between turns; prompts are *not* sent over the RPC channel. The child loads this extension, joins the dashboard as a normal live instance (`PI_WEBAPP_HOST`, `PI_WEBAPP_PORT` and `PI_WEBAPP_SPAWN_ID` are set for it) and receives prompts over the regular WebSocket command path.
- **Prompt delivery.** An optional initial `prompt` is queued by the server and delivered as soon as the child registers — the `session_started` event carrying the spawn id — so the first turn starts without you touching the terminal.
- **Tracking.** The spawn record (pid, working directory, status, model, agent name, session id) is part of the dashboard state and is broadcast as it changes. The child's stdout/stderr is captured to `~/.pi/cache/pi-webapp/spawns/<spawnId>.log`; `GET /api/spawn/<spawnId>/log` returns the tail and `DELETE /api/spawn/<spawnId>` stops the process.

Requirements:

- `pi` must be on `PATH`, or set `PI_WEBAPP_PI_BIN` / pass `--pi`. Use an absolute path when the daemon's `PATH` does not resolve `pi`.
- The spawned `pi` must load the `pi-webapp` extension (`pi install git:github.com/luxuride-pi-extensions/pi-webapp`). Otherwise the process starts but never joins the dashboard, and the initial prompt stays queued.
- Spawning only works on the primary instance (the one that owns the HTTP server) and only when it is bound to a loopback address (`127.0.0.1`, `localhost`, `::1`). A secondary instance or a non-loopback bind answers `403`; disable spawning entirely with `PI_WEBAPP_SPAWN=0` or `--no-spawn`.

### Taking over and removing sessions

Leeched sessions are read-only until you take them over.

- **Take over** (`↻` in the sidebar, or the header button) resumes the session in a new `pi --mode rpc --session <file>` process, so the history stays and the session id is unchanged. Ownership is detected by scanning `/proc/<pid>/environ` for `PI_SESSION_ID` together with a `pi` argv0 — a session is refused while its owner is mid-turn (`409 owner-busy`). When the owner is alive but idle, the dashboard asks before stopping that `pi` process and taking its place; the owning pid is shown in the sidebar as `pid N`.
- **Subagents are never taken over** (`409 subagent`) and neither are live sessions (`409 live`).
- **Remove** (`⌫`, or the header button) hides a session and its subagents from the dashboard and writes a tombstone to `~/.pi/cache/pi-webapp/.removed-sessions.json`, so later events and rescans do not bring it back. Dashboard-started processes are stopped first. Tick *Also delete the transcript file* to unlink the `*.jsonl` as well — that is permanent.

> **Caveat: spawned sessions inherit the dashboard's environment** — `PATH`, proxies, API keys, `PI_*` configuration and anything else the daemon was started with. They run with the privileges of the user running the dashboard. Starting a session is equivalent to running `pi` in that user's shell, so anyone who can reach the dashboard can do it. See [Security](#security).

### Model switching

The header of a live session shows a **model** select as soon as its owning `pi` instance reported the models it has credentials for. Picking one sends `POST /api/sessions/:id/model`; the owning instance resolves it through `ctx.modelRegistry` and calls `pi.setModel`, then broadcasts a `session_meta` event so every dashboard agrees on the new model. Refused cases: leeched sessions (`409`), unknown models or providers without auth (`409` with the reason), sessions owned by another instance that is offline. The switch is per session — the configured default is untouched.

## Plugins

The dashboard can host panels written by other extensions. A plugin is a directory with its own HTML/JS/CSS; the dashboard sandboxes it in an iframe and feeds it the session you are looking at.

```bash
# register a plugin directory with a running dashboard
node scripts/register-plugin.mjs examples/plugins/todo

# or directly
curl -X POST http://127.0.0.1:8787/api/plugins \
  -H 'content-type: application/json' \
  -d '{"id":"todo","name":"Todo list","dir":"/abs/path/to/plugin","panels":[{"id":"todos","title":"Todos","entry":"panel.html"}]}'
```

A manifest (`plugin.json` in the example) exposes `id` (`[a-z0-9-]`, 2–41 chars), `name`, `version`, `description`, `events` (event types you care about) and `panels[]` with `id`, `title`, `entry` (file inside the directory) and an optional `height`. Registration rejects relative or missing directories, entries that escape the directory, and unknown extensions; assets are served from `/plugins/<id>/<file>` with an extension allow-list.

Inside the panel, listen for one message type:

```js
window.addEventListener("message", (event) => {
  const payload = event.data;
  if (!payload || payload.type !== "pi-webapp:session") return;
  const { session, events } = payload;
  render(session, events.filter((e) => e.type === "tool_end"));
});
```

The parent posts `{ type: "pi-webapp:session", session, events }` on load and whenever the session changes, and the iframe is created with `sandbox="allow-scripts"` (no same-origin access to the dashboard). Panels are stored in `~/.pi/cache/pi-webapp/.plugins.json`; `DELETE /api/plugins/:id` unregisters one. This is how an extension ships its own view — todo state, pi-lens diagnostics, a Playwright report — without the dashboard knowing about it.

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

The extension is configured through environment variables — extension mode has no CLI flags. The standalone daemon adds a few flags on top (see [Standalone daemon](#standalone-daemon)).

| Variable | Default | Description |
| --- | --- | --- |
| `PI_WEBAPP_PORT` | `8787` | Port for the dashboard server. `0` picks a free ephemeral port. |
| `PI_WEBAPP_HOST` | `127.0.0.1` | Bind address. Keep the loopback default unless a proxy fronts the server. |
| `PI_WEBAPP_CACHE_DIR` | `~/.pi/cache/pi-webapp` | Artifact cache root (one subdirectory per session). |
| `PI_WEBAPP_LEECH` | `1` | `0` disables session leeching entirely. |
| `PI_WEBAPP_LEECH_DIR` | `~/.pi/agent/sessions` | Colon-separated list of session directories to tail. |
| `PI_WEBAPP_LEECH_MAX_AGE_MS` | `900000` | Transcripts older than this are skipped unless a running `pi` process still owns them (minimum `30000`). |
| `PI_WEBAPP_PLAYWRIGHT` | *(auto-detected)* | Path to the Playwright CLI used by `capture_playwright_snapshot`. |
| `PI_WEBAPP_SPAWN` | `1` | `0`, `false` or `off` disables starting sessions from the dashboard. |
| `PI_WEBAPP_PI_BIN` | *(auto-detected)* | `pi` executable used for sessions started from the dashboard. |
| `PI_WEBAPP_AUTOSTART` | `1` | `0`, `false` or `off` disables the systemd autostart integration (postinstall and the `session_start` fallback). |
| `PI_WEBAPP_SKIP_AUTOSTART` | *(unset)* | `1` skips only the npm `postinstall` autostart step. |
| `PI_WEBAPP_SYSTEMD_UNIT` | `pi-webapp.service` | Overrides the systemd unit name (the test suite uses a throwaway unit). |
| `PI_WEBAPP_SESSION_DIR` | *(unset)* | Adds `--session-dir <dir>` to sessions started from the dashboard. |
| `PI_WEBAPP_SPAWN_ID` | *(set by the server)* | Spawn id handed to a `pi` process started from the dashboard; echoed back in its `session_started` event. |
| `PI_WEBAPP_PARENT_SESSION_ID` | *(set by the extension)* | Parent session id handed to a spawned child `pi` process. |
| `PI_WEBAPP_AGENT_NAME` | *(set by the extension)* | Subagent name handed to a spawned child `pi` process. |

Examples:

```bash
# move the dashboard to another port
PI_WEBAPP_PORT=9000 pi

# keep the dashboard, disable session leeching
PI_WEBAPP_LEECH=0 pi

# tail extra session directories (colon separated)
PI_WEBAPP_LEECH_DIR="$HOME/.pi/agent/sessions:$HOME/work/app/.pi/sessions" pi

# keep artifacts somewhere with more room
PI_WEBAPP_CACHE_DIR=/var/tmp/pi-webapp pi

# let the dashboard start sessions with a specific pi binary
PI_WEBAPP_PI_BIN=/usr/local/bin/pi npx pi-webapp

# dashboard only: no spawning, no leeching
PI_WEBAPP_SPAWN=0 PI_WEBAPP_LEECH=0 npx pi-webapp
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

The tool validates the paths, copies the media into `~/.pi/cache/pi-webapp/<sessionId>/`, broadcasts a work-state event (with the session id, parent session id and agent name) and returns the viewer URL plus the absolute artifact URLs. Missing files, unsupported extensions and empty files are rejected with an explicit error.

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

If Playwright is missing the tool fails gracefully with an install hint instead of crashing the session; set `PI_WEBAPP_PLAYWRIGHT` when the CLI lives outside the project (`node_modules/.bin/playwright`).

Example prompt to your agent:

> Before you finish, start the dev server, call `capture_playwright_snapshot` on `http://localhost:3000` with the title "Checkout wired up", then call `post_work_state` with a summary of what changed.

## Subagent integration

Subagent activity is stitched back into the dashboard in three ways.

**Out-of-process subagents.** When a subagent tool launches a separate `pi` process, the extension injects environment variables at `tool_execution_start`:

- `PI_WEBAPP_PARENT_SESSION_ID` — the spawning session
- `PI_WEBAPP_AGENT_NAME` — the subagent name

Launchers that use the older variable names are supported too: `PI_PARENT_SESSION_ID` and `PI_SUBAGENT_NAME`. A child `pi` also detects its parent from the `parentSession` field in its session header, so the tree survives even when the environment was not propagated. The child then registers itself as a subagent and its events are attributed to the child session.

**In-process subagents.** Tool calls named `subagent`, `Agent`, `SubagentWorkflow` or `Task` are intercepted at their boundaries. A call becomes a `subagent_spawned` event on the parent session (data: `childSessionId`, `agentName`, `task`, `callId`) and its result becomes `subagent_completed` (data: `childSessionId`, `status`, `summary`, `durationMs`). No extra plumbing is needed in the subagent itself.

**Artifact attribution.** Screenshots and recordings published by a subagent are stored under the child session's cache directory, surfaced in the child's work-state panel, and echoed into the parent feed as `[subagent: name]` entries so the parent timeline still tells the whole story. The dashboard renders the hierarchy as a tree — parent at the root, children indented, each node with its own status dot, task text and media.

## Architecture

### File map

| Path | Responsibility |
| --- | --- |
| `src/protocol.ts` | Shared wire contract: event/session types, defaults, env names, helpers. Dependency-free so the browser bundle can import it. |
| `src/index.ts` | pi extension entry point: starts or joins the server, translates pi session events, registers tools, propagates subagent env. |
| `src/daemon.ts` | `pi-webapp serve`: flag parsing, daemon bootstrap, pid file, help/version output and signal handling. |
| `src/daemonctl.ts` | Detached-daemon control used by `/webapp daemon start|stop|status`: health probe, pid file, start/stop lifecycle. |
| `src/server.ts` | HTTP + WebSocket server: static assets, `/api/*`, artifact streaming with `Range`, prompt routing, instance registry, spawn routes. |
| `src/spawn.ts` | `SessionSpawner`: launches `pi --mode rpc`, tracks spawn records, captures logs and stops children. |
| `src/storage.ts` | Artifact cache helpers: `ingestArtifact` copies screenshots/recordings into the cache, MIME lookup, cache-root resolution and pruning. |
| `src/leech.ts` | Tails pi session JSONL files and replays them as read-only `leech` sessions. |
| `src/bridge.ts` | Extension-mode startup glue: boots a `WebappServer` (and its `SessionSpawner`) when the port is free, otherwise joins the existing primary through `WebappClient`; wires the prompt handler and artifact pruning. |
| `src/client.ts` | Client used by secondary instances to talk to the primary server (instance socket, command ack). |
| `src/tools.ts` | `post_work_state` and `capture_playwright_snapshot` tool definitions. |
| `bin/pi-webapp.mjs` | Executable shim for the standalone daemon; loads `dist/daemon.js`. |
| `web/main.tsx`, `web/*` | Preact dashboard: feed, subagent tree, work-state panel, prompt box. |
| `scripts/build.mjs` | Build pipeline (tsc, Tailwind CLI, esbuild, static shell). |
| `scripts/prepare.mjs` | `prepare` hook: reuses the committed `dist/` unless it is incomplete or `PI_WEBAPP_FORCE_BUILD=1`. |

### Request and event flow

Primary flow — the `pi` process that owns the dashboard:

```text
pi session ──events──▶ bridge.ts ──POST /api/events──▶ server.ts ──▶ storage.ts
                                                            │
browser ──WS /ws──▶ snapshot + event stream ◀───────────────┘
browser ──POST /api/sessions/:id/prompt──▶ local prompt handler ──▶ pi session
```

Secondary flow — additional `pi` processes:

```text
pi #2 ──WS /ws?role=instance&instanceId=…──▶ primary server
      ◀── {type:"command"} ── prompt for a session owned by this instance
      ──▶ {type:"command_ack"} ── accepted/rejected
```

Standalone flow — `pi-webapp serve`, no agent process required:

```text
pi-webapp serve ──serve dashboard + leech session files──▶ browser
       │
       ├── leech ~/.pi/agent/sessions ──▶ read-only sessions
       ├── pi (extension loaded) ──WS role=instance──▶ live instances
       └── POST /api/spawn ──▶ pi --mode rpc ──▶ child joins as an instance
```

Three ways to own the dashboard:

| Mode | Who owns the port | Use it for |
| --- | --- | --- |
| Daemon | `pi-webapp serve` | always-on dashboard, sessions started from the browser, history without a running agent |
| Primary `pi` | the first `pi` with the extension | a normal coding session with the dashboard attached |
| Secondary `pi` | joins the owner as an instance | extra sessions; prompts are routed over WebSocket |

Only the port owner can start sessions: the daemon and an extension-primary both install a `SessionSpawner`, secondaries cannot.

### WebSocket messages

One endpoint, `/ws`, two roles.

Server → client: `snapshot` (full state on connect), `event`, `session`, `session_removed`, `session_renamed`, `spawn`, `spawns`, `models`, `plugins`, `command`, `model_command`, `hello_ok`, `pong`.
Client → server: `hello` (`role: "ui" | "instance"`, optional `instanceId`), `command_ack`, `model_command_ack`, `models`, `ping`.

### HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/state` | Full dashboard state: sessions, recent events, counts, leech status, spawn state. |
| `GET` | `/api/health` | Liveness probe, `{ "ok": true }`. |
| `POST` | `/api/events` | Ingest an event: `{ instanceId, event }`. Used by instances and the extension. |
| `POST` | `/api/sessions/:sessionId/prompt` | Send a prompt to a session. `200 { ok, delivered: "local" }`, `202` when routed to another instance, `409` for leech-only sessions, `404` for unknown ids. |
| `POST` | `/api/sessions/:sessionId/takeover` | Resume a leeched session in a new `pi` process: `202 { ok, spawn, killedPid? }`; `409 live`, `409 subagent`, `409 owner-busy`, `409 owner-running` (`{ code, canKill: true, pid }` — resend with `{ kill: true }`), `409 takeover-pending`, `403` when spawning is disabled. |
| `POST` | `/api/sessions/:sessionId/model` | Switch the session's model: `{ provider, modelId }`. `200 { ok, delivered: "local" \| "instance" }`, `400` for a missing field, `409` for leech-only sessions or a rejected switch, `404` for unknown ids. |
| `DELETE` | `/api/sessions/:sessionId` | Remove a session and its subagents from the dashboard. Body `{ deleteFile?: boolean }` also unlinks the transcript. `200 { ok, removed, deletedFile? }`, `404` for unknown ids. |
| `GET` | `/api/plugins` | Registered plugin manifests. |
| `POST` | `/api/plugins` | Register a plugin: `{ id, name, dir, panels[], events?, description?, version? }`. `201 { ok, plugin }`, `400` for an invalid manifest. |
| `DELETE` | `/api/plugins/:id` | Unregister a plugin. `200 { ok: true }`, `404` when unknown. |
| `GET`/`HEAD` | `/plugins/<pluginId>/<file>` | Plugin asset from the plugin's own directory (extension allow-list, no-cache). |
| `GET` | `/api/leech` | Leech status: `enabled`, `running`, `dirs`, `files`, `sessions`, `skippedStale`, `maxAgeMs`, `lastScanAt`, `lastError`. |
| `POST` | `/api/leech/scan` | Force a rescan of the configured session directories. |
| `GET` | `/api/spawn` | Spawn state: `{ enabled, spawns, defaultCwd? }`. |
| `POST` | `/api/spawn` | Start a `pi` session: `{ cwd, prompt?, model?, agentName?, sessionFile?, extraArgs? }`. `201 { ok, spawn }`, `403` when spawning is disabled, `400` for an invalid request (cwd must be absolute and exist). |
| `DELETE` | `/api/spawn/:spawnId` | Stop a session started from the dashboard. `200 { ok: true }`, `409` when it is not running, `404` for unknown ids. |
| `GET` | `/api/spawn/:spawnId/log` | Plain-text tail of the spawned process log (`text/plain`). |
| `GET`/`HEAD` | `/artifacts/<sessionId>/<filename>` | Artifact download with `Accept-Ranges: bytes`; partial requests answer `206`/`416`. |

Dashboard assets are served from `dist/web/` at `/`, `/app.js` and `/app.css`.

### Artifact cache layout

```text
~/.pi/cache/pi-webapp/
└── <sessionId>/
    ├── m9x2k1-7f3a-login-form.png
    └── m9x2k1-91bd-login-flow.webm
```

Files are named `<timestamp base36>-<random>-<safe original name>`, which keeps uploads from different ticks unique and prevents path tricks in the original filename. Each artifact is capped at 512 MiB (`MAX_MEDIA_BYTES`); ingestion rejects missing, empty and oversized files as well as unsupported extensions.

## Multi-instance setups

Run as many `pi` processes as you like; they cooperate around one dashboard:

- **Election** — the first process to bind `PI_WEBAPP_PORT` becomes the primary and owns the server. Later processes find the port taken, connect to the primary as an instance and keep working. The [standalone daemon](#standalone-daemon) can be that primary too.
- **Prompt routing** — the server tracks which instance owns each session. A prompt for a session owned by the primary goes to the local handler (`delivered: "local"`); a prompt for a session owned by another instance is pushed as a `command` over that instance's socket (`202`, `delivered: "instance"`) and acknowledged with `command_ack`.
- **Spawning** — the primary can start new `pi` processes; those sessions join as instances and are tagged with their spawn id. Only a loopback-bound primary allows it (see [Starting sessions from the dashboard](#starting-sessions-from-the-dashboard)).
- **Leeching** — sessions run without the extension still show up when their project directory is covered by `PI_WEBAPP_LEECH_DIR`. Leech sessions are read-only until taken over: prompting one answers `409`, because there is no live process to steer; `POST /api/sessions/:id/takeover` resumes it in a new `pi` process instead.

The dashboard does not care which process is primary — the browser always talks to `http://127.0.0.1:8787`.

## Security

`pi-webapp` is a local developer tool and deliberately ships without accounts, sessions or tokens.

- **Loopback by default.** `PI_WEBAPP_HOST=127.0.0.1` means only the local machine can reach the dashboard, and browsers on other machines cannot.
- **No login by design.** Anyone who can reach the port can read your transcripts, download artifacts and send prompts to your agents. Treat the port as equivalent to your shell.
- **Spawning runs commands.** `POST /api/spawn` starts `pi` in a directory of the caller's choosing with the dashboard's environment and privileges. It is limited to a loopback-bound primary and can be disabled with `PI_WEBAPP_SPAWN=0` or `--no-spawn`; anyone who can reach the port can otherwise use it.
- **Path traversal protection.** Artifact URLs are resolved and checked against the artifacts root; encoded traversal attempts (`..%2f..%2fetc/passwd`) are rejected with `400`/`403`/`404` and never leak files outside the cache.
- **Artifact caps.** Uploads are validated by extension and size (512 MiB ceiling) and stored under generated names, so a session cannot overwrite arbitrary files in the cache.
- **Threat model.** Trusted local user on a trusted machine. If you need remote access, put an authenticating proxy in front (next section) and keep the origin on loopback. `PI_WEBAPP_HOST=0.0.0.0` exposes read *and* write access to every reachable network — it is unsafe without that proxy.

## Running behind a reverse proxy

WebSocket upgrades and `Range` requests must reach the origin untouched. Terminate TLS and authenticate at the proxy, and keep `PI_WEBAPP_HOST=127.0.0.1`.

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
		auth_basic "pi-webapp";
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
| `EADDRINUSE` on start | Another `pi` already owns the port. Instances join it automatically; the message is informational. Change `PI_WEBAPP_PORT` if you want a separate dashboard. |
| Blank dashboard | Assets are missing: run `npm run build` (or reinstall the package). Check that `dist/web/app.js`, `dist/web/app.css` and `dist/web/index.html` exist. |
| Video will not scrub | A proxy is stripping `Range`. Verify `curl -sI -H 'Range: bytes=0-1' http://127.0.0.1:8787/artifacts/<id>/<file>.webm` answers `206` with `Content-Range`. |
| `capture_playwright_snapshot` fails | Playwright not installed: `npm i -D playwright && npx playwright install chromium`. Set `PI_WEBAPP_PLAYWRIGHT` if the CLI is elsewhere. |
| Subagents missing from the tree | Restart `pi` so the extension reloads, and check that the launcher passes `PI_WEBAPP_PARENT_SESSION_ID`/`PI_WEBAPP_AGENT_NAME` (or the legacy `PI_PARENT_SESSION_ID`/`PI_SUBAGENT_NAME`). In-process subagent tools are detected by name — custom wrappers are not. |
| Leech list is empty | `PI_WEBAPP_LEECH=0` disables it; make sure `PI_WEBAPP_LEECH_DIR` points at the directories that actually contain `*.jsonl` session files, then `POST /api/leech/scan`. |
| Prompt returns `409` | The session is leeched (read-only). Start the session through `pi` with the extension to steer it. |
| Prompt returns `404` | Unknown session id — the dashboard has not seen that session yet. |
| `POST /api/spawn` returns `403` | Spawning is disabled (`PI_WEBAPP_SPAWN=0`/`--no-spawn`), this is a secondary instance, or the server is not bound to loopback. |
| Spawned session never appears | The spawned `pi` must load the `pi-webapp` extension; check `GET /api/spawn/<id>/log` and that `PI_WEBAPP_PI_BIN`/`--pi` points at the `pi` binary you actually use. |
| Spawn fails with "pi executable not found" | `--pi`/`PI_WEBAPP_PI_BIN` names a path that is not executable. Use an absolute path or rely on `PATH`. |

## Development

```text
pi-webapp/
├── src/                  extension + server + daemon (TypeScript, ESM)
├── web/                  Preact dashboard (Tailwind v4 + daisyUI)
├── scripts/build.mjs     tsc, Tailwind CLI, esbuild, static shell
├── scripts/postinstall.mjs  enables the systemd user service after `npm install`
├── bin/pi-webapp.mjs     standalone `pi-webapp` CLI shim
├── src/systemd.ts        systemd unit generation, autostart convergence
├── tests/smoke.mjs       end-to-end smoke test (server + extension contract)
├── tests/daemon.mjs      standalone daemon + spawn lifecycle test
├── tests/autostart.mjs   systemd unit + install/uninstall/opt-out test
├── dist/                 build output (generated, committed, shipped in the package)
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

Commands:

```bash
npm run build         # compile backend + dashboard
npm run typecheck     # strict TypeScript check, no emit
npm run check         # typecheck + syntax-check the dashboard bundle
npm test              # smoke test (requires a build)
node tests/daemon.mjs # standalone daemon test (requires a build)
node tests/autostart.mjs  # systemd autostart test (skips without a user session)
```

`dist/` is committed so that `pi install git:...` always ships a working
dashboard bundle, even where the build toolchain is unavailable (`--omit=dev`)
or lifecycle scripts are suppressed. `npm run build` regenerates it; the `prepare` hook reuses an existing
`dist/` unless it is incomplete or you set `PI_WEBAPP_FORCE_BUILD=1`. Re-run
`npm run build` after changing `src/` or `web/`, and commit `dist/` with the
change.

`npm test` boots a real server on an ephemeral loopback port and walks the public contract: static assets, event ingestion, WebSocket snapshot and broadcast, `Range` streaming (206/416/traversal rejection), prompt routing (local, instance, leech, unknown), leech tailing of a session file and the spawn API lifecycle. It writes only to a temporary directory and exits non-zero on the first failing step, naming it.

`node tests/autostart.mjs` checks the generated unit and then, when a systemd user session is available, installs a throwaway unit (`PI_WEBAPP_SYSTEMD_UNIT`), asserts it is enabled and answering, verifies a second daemon waits on a busy port, uninstalls it and confirms the opt-out is respected. It skips cleanly in containers.

`node tests/daemon.mjs` boots the real `bin/pi-webapp.mjs serve` daemon on a free port with a fake `pi` executable (no model calls), then checks the dashboard, `POST /api/spawn`, the spawn log tail, `DELETE`, status transitions, `SIGTERM` shutdown and port release. Like the smoke test it is dependency-free and writes only to a temporary directory; it prints `DAEMON OK` or `DAEMON FAIL: <reason>`.

Contributions: keep `src/protocol.ts` dependency-free (the browser imports it), add a step to `tests/smoke.mjs` for new wire behaviour, and run `npm run check` before sending a patch.

## License

MIT © 2026 luxuride-pi-extensions. See [LICENSE](LICENSE).
