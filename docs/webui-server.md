# Web UI Server — `webui/server.js`

A ~2,000-line Node HTTP server that is the browser cockpit for the whole hub. It is
intentionally close to dependency-free — the only npm deps are **`ssh2`** and **`ws`** (for
the SSH terminal bridge); everything else uses Node built-ins. It authenticates browsers,
spawns `claude.exe` for chat, serves git/files/sessions/devices/skills/tasks APIs, proxies to
peer devices, and serves the built React app from `webui/dist/`.

- **Process:** PM2 `hub-webui`, `max_memory_restart: 200M`, listens on **8088**.
- **Env:** see [PORTS-AND-ENV.md](PORTS-AND-ENV.md). **Frontend:** see
  [webui-frontend.md](webui-frontend.md). **Agent protocol:** see
  [ARCHITECTURE.md](ARCHITECTURE.md).

## Auth & roles

| Function | ~line | Role |
|---|---|---|
| `handleLogin(req,res)` | 797 | `POST /api/login`: compare against `HUB_PASSWORD` (owner) or `HUB_GUEST_PASSWORD` (guest); issue a token; set `hub_auth` cookie (HttpOnly, SameSite=Strict, 30 d). |
| `issueToken(role)` | 114 | UUID token → `validTokens` map. |
| `isAuthed(req)` | 115 | Read the cookie, return `'owner'`/`'guest'`/null. |

Two auth paths: the **cookie** (browsers) and the **`x-device-token` header** for the
`/agent/*` cross-device surface. `owner` can do everything; `guest` is limited to `guest-*`
conversations and gets tools stripped on chat.

## Persistence helpers

| Group | Functions (~line) | Stores |
|---|---|---|
| Conversations | `convPath` `loadConv` `saveConv` `createConv` `listConvs` (124–150) | `webui/conversations/<id>.json` |
| Devices | `loadDevices` `saveDevices` `findDevice` `isSelfDevice` (43–62) | `webui/devices.json` |
| Projects | `normWorkdir` `loadProjects` `saveProjects` `loadHiddenProjects` `addHiddenProject` (158–201) | `webui/projects.json` + `~/.claude.json` discovery |
| Workflows | `loadWorkflows` `saveWorkflows` (153–156) | `webui/workflows.json` |
| Connectors | `claudeJsonPath` `loadClaudeJson` `saveClaudeJson` (204–212) | `~/.claude.json` `mcpServers` |

## Core helpers

| Function | ~line | Role |
|---|---|---|
| `resolveClaude()` | 90 | Locate `claude.exe` (Windows-aware; honors `HUB_CLAUDE_EXE`). |
| `routeClaudeEvent(line, send, sess)` | 988 | Parse one NDJSON line from claude stdout → emit `text`/`tool`/`usage`/`done`; capture `session_id` on init. |
| `run(cmd, args, cb)` | 1249 | Spawn a child process, collect stdout/stderr, fire `cb` exactly once (used by all git endpoints). |
| `safeWorkdirPath(rel)` | 1176 | Reject `../` escapes — confine file ops to `CFG.workdir`. |
| `parsePorcelain(st)` | 1265 | Parse `git status --porcelain` into staged/unstaged/untracked/conflicted. |
| `proxyToDevice(dev,req,res,url)` | 1620 | Transparently pipe a request (JSON or SSE) to a peer's `/agent` surface with the device token. |
| `pingDevice(dev, cb)` | 1655 | 3.5 s health probe of a peer. |
| `readBody` / `sendJson` | 2034 / 2042 | 1 MB-capped body reader; JSON responder. |
| `loadDotEnv(file)` | 2046 | Parse `.env` into `process.env`. |

## HTTP route table

Static/PWA (no auth): `GET /`, `/legacy`, `/assets/*`, `/favicon.svg`, `/manifest.json`,
`/sw.js`, `/healthz`. Auth: `POST /api/login`.

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/api/config` | Get/set model, workdir, effort. |
| GET/POST | `/api/params` | System prompt, permission mode, turn timeout (`params.json`). |
| POST | `/api/chat` | **Streaming** chat turn (NDJSON) — spawns claude (`handleChat`, 814). |
| GET | `/api/conversations` | List (owner: all; guest: `guest-*` only). |
| GET/DELETE/PATCH | `/api/conversations/{id}` | Fetch / delete / rename. |
| POST | `/api/conversations/{id}/fork\|truncate\|compress` | Clone / keep first N / summarize old turns (haiku). |
| GET | `/api/files`, `/files/read`, `/files/raw` | Browse / read / download (workdir-confined). |
| POST | `/api/upload` | Upload into workdir / `uploads/`. |
| GET | `/api/git/status`, `/diff`, `/branches` | Status (porcelain + ahead/behind + upstream), diffs, branch list. |
| POST | `/api/git/{commit,stage,unstage,discard,fetch,pull,push,branch,branch-delete,stash,merge,resolve,abort,ai-message}` | Full VS Code-style git ops; `ai-message` writes a commit message via haiku. |
| GET | `/api/github`, `/github/accounts` | PRs+issues via `gh`; logged-in accounts. POST `/github/switch`. |
| POST | `/api/command` | Whitelisted pm2/git/logs actions (`handleCommand`, 1026). |
| GET | `/api/dashboard` | Console tasks + pm2 + WhatsApp status + live sessions (`handleDashboard`, 1096). |
| GET (SSE) | `/api/logs` | Live `pm2 logs` stream (`handleLogs`, 1603). |
| GET | `/api/analytics` | 14-day token usage from `usage-log.json` (`handleAnalytics`, 1962). |
| GET | `/api/sessions` | List live Claude Code transcripts (`listSessions`). |
| GET (SSE) | `/api/sessions/{id}/stream` | Replay tail then live-tail a session (`handleSessionStream`). |
| GET/POST/PUT/DELETE | `/api/skills[/{slug}]` | CRUD over `~/.claude/skills/<slug>/SKILL.md`. |
| GET/POST | `/api/tasks`, POST `/api/tasks/{id}/stop` | Headless `claude -p` task bridge (`handleTasksPost`, 1914). |
| GET/POST/DELETE | `/api/connectors[/{name}]` | MCP servers in `~/.claude.json`. |
| GET/POST/DELETE | `/api/workflows` | Saved/scheduled prompts. |
| GET/POST/DELETE | `/api/projects`, POST `/api/projects/{id}/activate` | Project switch + scaffolding (node/python/vite-react/empty). |
| POST | `/api/open` | Launch VS Code (Remote-SSH) / Windows Terminal / Explorer (`handleOpen`, 595). |
| GET | `/api/usage` | Live 5h/7d limits from `api.anthropic.com` via `~/.claude/.credentials.json` (`handleUsage`, 240; 60 s cache). |
| GET | `/api/wa-status`, `/api/wa/*` | Proxy to the WhatsApp daemon (8091): approvals, jobs, override. |
| GET | `/api/devices`, `/api/device/health`, `/api/device/pubkey` | Peer list (+pings), this node's health, SSH pubkey. POST/DELETE `/api/devices[/{id}]`. |
| (any) | `/agent/*` | Device-token-authed mirror of `/api/*` for cross-device proxying. |

## Chat handler details (`handleChat`, 814)

Parses `{message, sessionId, model, convId, ephemeral, params}`; reuses or creates the
session; replays conversation history into a `<conversation-history>` block when the claude
session is new; spawns claude with the stream-json flags (see ARCHITECTURE.md); for **guests**
passes `--disallowedTools` (Bash/Read/Edit/Write/Glob/Grep/WebFetch/Task/Agent/MCP/…) and
`permission-mode default`. Streams NDJSON back with `X-Session-Id`/`X-Conv-Id` headers; on
close, appends the assistant turn to the conversation (unless `ephemeral`). A kill-timer
enforces `HUB_TURN_TIMEOUT_MS`.

### Example: drive a chat turn from curl
```bash
curl -N http://127.0.0.1:8088/api/chat \
  -H "cookie: hub_auth=<token>" -H 'content-type: application/json' \
  -d '{"message":"list the open PRs","model":"sonnet","convId":"<uuid>"}'
# → NDJSON: {"type":"text","text":"…"} … {"type":"done","sessionId":"…"}
```

## Session mirror (≈1700–1838)

`claudeProjectsDir()`, `peekSession(fp,size)` (sample head/tail for cwd + last prompt),
`listSessions()` (active = mtime within the recent window), `transcriptEvents(o)` (JSONL line
→ user/assistant/thinking/tool/tool-result event), `handleSessionStream` (replay last ~250 KB,
then poll-tail at a byte offset). This is the read-only "watch what's happening live" feature.

## SSH terminal bridge (`setupTerminalBridge`/`bridgeTerminal`, ≈695)

A WebSocket upgrade on `/api/term?device=<id>&cwd=<path>` (owner cookie only). Resolves the SSH
target (`resolveSshTarget`), connects with `ssh2` using `~/.ssh/id_ed25519`, opens an
`xterm-256color` shell, and bridges keystrokes ↔ output. JSON `{resize}` frames call
`setWindow`. If `ssh2`/`ws` are missing the feature is disabled but the server still starts.

## Workflow scheduler (≈1981–2031)

`workflowDue(wf, now)` evaluates `{type:'every',minutes}` or `{type:'daily',time:'HH:MM'}`; a
60 s loop spawns a claude turn and saves the result to a `wf-<ts>` conversation.

## Resilience

An uncaught-exception handler logs to `_crash.log` and keeps the server alive. Missing
`ssh2`/`ws` → terminal disabled, not fatal. Peer unreachable → request returns 502 with an
error rather than hanging.
