# Architecture

## Process model

Five long-lived processes run under **PM2** (auto-start on boot via `pm2 save` + a Windows
startup hook). Two more classes of process are **spawned on demand** and are not under PM2.

```
                          ┌──────────────────────────────────────────────┐
   Tailscale (WireGuard)  │            Windows laptop, 24/7               │
  ─────────────────────►  │                                              │
                          │  PM2 ─ hub-webui     (webui/server.js)  :8088 │  ◄─ browser
                          │  PM2 ─ whatsapp-mcp  (index.js)         :8091 │  ◄─ WhatsApp
                          │  PM2 ─ memory-store  (index.js)         :8094 │
                          │  PM2 ─ gmail-monitor (index.js)         :8093 │
                          │  PM2 ─ price-tracker (index.js)         :8095 │
                          │  OpenSSH                                  :22 │  ◄─ ssh
                          │                                              │
                          │  on demand (spawned by claude.exe, stdio):   │
                          │     mcp/whatsapp-bridge.js  → :8091          │
                          │     mcp/memory-bridge.js    → :8094          │
                          │     mcp/gmail-bridge.js     → :8093          │
                          │     mcp/notion-bridge.js    → Notion API     │
                          │     calendar-bridge/index.js→ Google API     │
                          │     @playwright/mcp (headless Chromium)      │
                          │  on demand (spawned by webui/whatsapp):      │
                          │     claude.exe  (the agent itself)           │
                          │     tts-service/tts_server.py (F5-TTS) :5050 │
                          └──────────────────────────────────────────────┘
```

### Why daemons + thin bridges?

Several resources are **singletons** or expensive: the one allowed WhatsApp Web session, the
SQLite databases, a Chromium instance. If every `claude.exe` session opened its own copy you'd
get connection conflicts (WhatsApp only permits one linked client) and wasted RAM. So:

- A **daemon** owns the resource and exposes a small **loopback HTTP API**.
- A **stdio MCP bridge** (`mcp/*.js`) is spawned per Claude session and simply forwards MCP
  tool calls to the daemon's HTTP API. Bridges are stateless and cost ≈0 idle RAM.

This is why, e.g., `whatsapp-bridge.js` (an MCP server Claude talks to) is separate from
`whatsapp-mcp/index.js` (the daemon that actually holds the WhatsApp connection).

## The `claude.exe` stream-json protocol

Both the Web UI (`webui/server.js`) and the WhatsApp daemon (`whatsapp-mcp/index.js`) drive
the agent the same way: spawn the **native** `claude.exe` and talk JSON over stdio.

**Spawn (Web UI form):**
```
claude.exe --input-format stream-json --output-format stream-json
           --include-partial-messages --verbose
           --permission-mode bypassPermissions
           --model <haiku|sonnet|opus|claude-…>
           --session-id <uuid>     # first turn
           --resume <uuid>         # subsequent turns
```
The WhatsApp daemon uses a simpler `-p --output-format json` form for one-shot tasks and
`spawnClaudeText()` for quick text completions.

**Input** — write to stdin, then close it:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"your prompt"}]}}
```
Sending via stdin (not argv) avoids shell injection and lets the process exit cleanly when
stdin closes.

**Output** — newline-delimited JSON (NDJSON). The parsers route on these shapes:
```json
{"type":"system","subtype":"init","session_id":"…"}                       // capture session id
{"type":"stream_event","event":{"type":"content_block_delta",
   "delta":{"type":"text_delta","text":"…"}}}                              // live tokens
{"type":"stream_event","event":{"type":"content_block_start",
   "content_block":{"type":"tool_use","name":"Bash"}}}                     // tool indicator
{"type":"stream_event","event":{"type":"content_block_delta",
   "delta":{"type":"input_json_delta","partial_json":"…"}}}               // tool args
{"type":"result","is_error":false,"usage":{…},"session_id":"…"}            // final + usage
```

**Hard-won gotchas (keep these in mind when editing the spawners):**
- Spawn the **native exe** with `shell:false`. Going through `claude`/`claude.cmd` uses
  cmd→powershell and fails with EPERM under a PM2/background/service launch.
- Use `res.on('close')` guarded by `!res.writableEnded` to detect client disconnect — **not**
  `req.on('close')`, which fires as soon as the request body is read and would kill claude
  before it answers.
- Auth is **file-based** (`~/.claude/.credentials.json`, not the OS keychain), so background
  processes running as the same user authenticate fine.

## Session continuity

A UUID is generated per browser/chat session. The first turn passes `--session-id <uuid>`;
later turns pass `--resume <uuid>` to keep the model's context. If the conversation has prior
messages but the underlying claude session is new (e.g. after a restart), the server replays
earlier turns inside a `<conversation-history>` block so context isn't lost.

## Two-tier (and three-tier) `/claude` on WhatsApp

A deliberate security design (see also [whatsapp-daemon.md](whatsapp-daemon.md)):

| Tier | Trigger | Engine | Capability |
|---|---|---|---|
| **Owner** | `msg.fromMe` (you) | `claude.exe` `bypassPermissions` | Full agent: code, files, browser, all MCP tools |
| **Override contact** | a trusted contact who passed `/claude-override <password>` | `claude.exe` restricted prompt (`buildOverridePrompt`) | Web research / coding / Q&A only — **no** personal data, gmail, calendar, notion, files |
| **Guest / incoming** | anyone else, only where `/claude-enable`d | stateless **Groq** (or Gemini fallback) API | Casual chat only — **zero** machine access, injection-proof |

`claude.exe` is a coding agent and ignores attempts to demote it to "simple chat", so guests
never touch it — they get a stateless API call with no tools. The guest tier is **off per
chat by default**; the owner enables it explicitly.

## Multi-device cockpit

The same `webui/server.js` runs on every node. Cross-device control rides a shared secret:

- `HUB_DEVICE_TOKEN` authorises the `/agent/*` surface via the `x-device-token` header
  (**not** the browser cookie).
- Any owner `/api/*` call with `?device=<id>` is transparently proxied to that peer's
  `/agent` surface (JSON **and** SSE) by `proxyToDevice()`. Agent requests never re-proxy
  (loop guard).
- `webui/devices.json` is the peer registry (`[{id,name,host,agentPort,kind}]`); self is
  auto-detected from hostname / `HUB_DEVICE_ID`.

## Live session mirror & task bridge

- `/api/sessions` lists Claude Code transcripts under
  `~/.claude/projects/<encoded-cwd>/<id>.jsonl`; `/api/sessions/:id/stream` replays the tail
  then tails live by polling the JSONL at a byte offset, converting lines into render events.
- `POST /api/tasks` spawns a headless `claude -p` with a known `--session-id` → a real
  session that shows up **both** in the mirror and in the dashboard's Console Tasks card.

## Console Tasks pipeline

The dashboard's "Console Tasks" card reads `claude-tasks.json`, written by
`scripts/sync-claude-tasks.js`. That script is wired to **user-level** Claude hooks (in
`~/.claude/settings.json`, *not* in the repo): `UserPromptSubmit` + `Stop` record every
console session; `PostToolUse` on `Task(Create|Update|Stop)` adds richer entries. Hook configs
are snapshotted at session start, so changes only affect newly-started sessions.

## Security model (summary)

- **Network:** Tailscale-only (WireGuard). Web UI on 8088 is firewalled to the Tailscale CIDR
  (`100.64.0.0/10`); daemon APIs bind `127.0.0.1` only.
- **Auth:** Web UI password → HttpOnly, SameSite=Strict cookie (30-day). Cross-device → device
  token header.
- **Sandboxing:** incoming WhatsApp `/claude` = Groq/Gemini with no tools. Web UI guests get
  tools stripped via `--disallowedTools` and `permission-mode default`.
- **Secrets:** `.env`, WhatsApp session, OAuth tokens, and runtime DBs/JSON are gitignored.
- **Authorization gate:** the auto-mode classifier prevents Claude from starting the
  bypassPermissions network services itself — the operator does that.
