# Web UI Frontend — `webui/app/`

A Vite + React single-page app (with a Three.js mascot/background) that is built to
`webui/dist/` and served by `webui/server.js`. The built `dist/` is committed so the server
machine can pull-and-run without a build step. Source lives in `webui/app/src/`.

Build: `cd webui/app && npm install && npm run build` (outputs to `../dist`). After rebuilding,
**`pm2 restart hub-webui`** — the server serves `dist/` live from disk, so a new frontend can
load against an old in-memory server otherwise (a real, previously-hit bug).

## Entry & shell

| File | Role |
|---|---|
| `main.jsx` | Mount `<App/>` to `#root`; register the service worker (`/sw.js`). |
| `App.jsx` (~422) | Root: auth state, role, tab routing (chat/files/devices/sessions/dashboard), modals, theme/mascot/3D toggle, active device + project, toasts, command palette, usage + WA-status polling. Hosts an event bus from `api.js`. Key fns: `changeModel`, `changeEffort`, `changePermMode`, `openApp`, `openTerminal`, `renameChat`. A `TabErrorBoundary` keeps one broken tab from blanking the app. |
| `api.js` (~51) | The HTTP + event layer: `bus`/`emit`/`on`; `dpath(p,device)` (append `?device=`); `api/getJSON/postJSON/patchJSON/delReq` (401 → emit logout); `streamChat(body,handlers,signal)` (read `/api/chat` NDJSON → `onMeta`/`onEvent`). |
| `themes.js` (~111) | `THEMES` (midnight, blueberry, daylight, synthwave, matrix, sakura, abyss…) — CSS vars + mascot + tagline; `applyTheme(id)`. |

## Feature components

| File | Renders / does |
|---|---|
| `Chat.jsx` (~580) | The chat surface. Streams turns via `streamChat`; renders user/bot/tool/sys/err items; ~36 slash-commands (`/help`, `/status`, `/logs`, `/git`, `/branch` fork, `/btw` ephemeral, `/model`, `/new`, `/theme`, `/compress`, `/export`, `/wa`, `/tasks`…); message edit/retry (truncate+resend), file attach (`/api/upload`), voice input (Web Speech API), markdown export. `abortRef` cancels a stream. |
| `Sidebar.jsx` (~121) | New-chat, search, conversations grouped by workdir, workflows (quick-launch), projects (`activateProject` → `/api/projects/{id}/activate`). |
| `Files.jsx` (~436) | Three tabs — **Files** (browse/upload/preview), **Git** (staged/unstaged/untracked, branches, commits, stash, diff with conflict resolve, `aiMessage` commit text), **GitHub** (PRs+issues via `gh`). Calls the `/api/files/*` and `/api/git/*` and `/api/github*` endpoints. |
| `Dashboard.jsx` (~154) | Console tasks, pm2 processes, WhatsApp status, usage limits (5h/7d), 14-day analytics, and an SSE live-logs card (`/api/logs`). Polls `/api/dashboard` every 10 s. |
| `Devices.jsx` (~144) | QR/connect card, per-device online status, SSH user/port edit, pm2 control, SSH pubkey copy, and Console/Files/Sessions quick-jump for each peer. |
| `Sessions.jsx` (~148) | Live Claude session list + read-only mirror (SSE `/api/sessions/{id}/stream`) + an inline "run task" composer (`POST /api/tasks`) that auto-watches the new session. |
| `Terminal.jsx` (~111) | Floating xterm.js drawer; each tab is a WebSocket to `/api/term` bridged over SSH (resize frames as JSON). |
| `Modals.jsx` (~196) | Connectors (MCP servers + presets), Workflow (name/prompt/schedule), Skills (SKILL.md CRUD), Project (name/workdir/template). |
| `Palette.jsx` (~74) | Ctrl-K command palette: new chat, switch tab, open app, change theme/mascot, run workflow, jump to project/recent chat. |
| `ParamsPanel.jsx` (~102) | System prompt, permission mode, turn timeout, theme/mascot/3D toggles. |
| `Markdown.jsx` (~37) | Lightweight markdown renderer for chat/session text. |
| `Mascot.jsx` (~167) + `three/SceneCanvas.jsx`, `three/Scenes.jsx` | The animated 3D character/background (sparky, cosmo, nova, sprinkles, sunny, kuba, bit, hana, mochi, or none). |

## PWA

`public/manifest.json` (name "Server Hub", standalone, dark theme) + `public/sw.js`
(cache `hub-v1`: cache-first for `/assets/`, network-first for the shell, **never** cache
`/api/*`). So the hub installs as an app on phone/desktop and the shell loads offline.

## Data shapes the UI relies on

See [runtime-files.md](runtime-files.md) for `conversations/*.json`, `devices.json`,
`projects.json`, `workflows.json`, `hub-config.json`, `params.json`, `hub-tasks.json`,
`usage-log.json`.
