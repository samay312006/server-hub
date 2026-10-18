# WhatsApp Daemon — `whatsapp-mcp/index.js`

The single most feature-dense file in the repo (~3,400 lines). It owns the **one** allowed
WhatsApp Web connection (via `whatsapp-web.js` → puppeteer/Chromium), routes every incoming
and outgoing message through a chain of handlers, drives the two/three-tier `/claude`, runs
12 feature verticals, exposes a loopback HTTP control API on **8091**, and — when **not** in
daemon mode — also acts as a stdio MCP server exposing ~35 WhatsApp tools to Claude.

- **Process:** PM2 `whatsapp-mcp`, `max_memory_restart: 700M` (Chromium is heavy).
- **Mode switch:** `WA_DAEMON=1` (set by PM2) → serve the HTTP control API + message handlers
  only; **without** it → register as a stdio MCP server (the tool set in *MCP tools* below).
- **Env / ports:** see [PORTS-AND-ENV.md](PORTS-AND-ENV.md). **Runtime files:** see
  [runtime-files.md](runtime-files.md). **Feature modules** (`features/*.js`), the digital
  twin, and the TTS service: see [whatsapp-features.md](whatsapp-features.md).

---

## Lifecycle & session management

| Function | ~line | Role |
|---|---|---|
| `getWebuiUrl()` | 28 | Detect the Tailscale IPv4 (`100.x.x.x`) to build the Web UI link for `/claude-webui`. |
| `initWithRetry(delayMs)` | 171 | Initialize the `whatsapp-web.js` client; retry loop on `ERR_NETWORK_CHANGED` / `ERR_INTERNET_DISCONNECTED` / `ERR_NAME_NOT_RESOLVED`. |
| `loadData()` / `saveData()` | 131 / 119 | Load/persist auto-reply config to `autoreply-data.json`. |
| `scheduleNext(job)` | 87 | Schedule a one-shot or repeating outbound message. |
| `resolveContactEntry()` | — | Resolve a contact across the `@lid` ↔ `@c.us` id quirk via `getContact().number`; cached in `lidCache`. |

**Auth flow:** `LocalAuth` stores the session in `.wwebjs_auth/`. On first run (or stale
session) a QR is written to `qr.png` and logged as `📱 QR SCAN NEEDED`. A **3-minute stale
guard** fires if the `ready` event doesn't arrive after auth: the daemon wipes the session and
regenerates a QR; the Web UI surfaces this via its WA-status banner.

---

## Message-handler pipeline

`whatsapp-web.js` fires `message_create` for **both** incoming and your own messages. Handlers
run in this order; `processedMessages` (a Set of message ids) dedupes:

1. `handleOverridePasswordCheck` — is this an override-password attempt? (line 1841)
2. passive memory capture — fire-and-forget log to memory-store (see `features/memory-watcher.js`)
3. `handleFillCommand` — `/fill*` (1279)
4. `handleEmailCommand` — `/email-*` (1348)
5. `handleMemoryCommand` — `/memory` `/note` `/remember` `/memory-stats` (1444)
6. `handleResearchCommand` — `/research` (1518)
7. `handleNotionCommand` — `/notion` (1543)
8. `handleCalendarCommand` — `/cal` (1884)
9. `handleGroupCommand` — `/group-*` (2016) + `watchGroupMessages` listener
10. `handleTrackCommand` — `/track` `/untrack` `/tracks` `/price-check` (2105)
11. `handleDocCommand` — `/doc*` (1736)
12. `handleRemindCommand` — `/remind` `/reminders` (2233)
13. `handleBriefingCommand` — `/briefing*` (2369)
14. `handleOngoingCommand` — `/claude-ongoing` `/claude-cancel` (1608)
15. `handleClaudeCommand` — `/claude` + all `/claude-*` variants (573)
16. `handleDigitalTwin` — twin auto-reply (2525)
17. `handleTwinCommand` — `/twin-*` (2555)
18. `handleAICommand` — `/grok` `/gemini` (397)

---

## Slash-command reference

> Unless noted, commands are **owner-only** (`msg.fromMe`). Sent from any chat; replies go to
> that chat (some, like `/claude-status`, deliberately reply to your own Saved Messages).

### Agent — `/claude` family → `handleClaudeCommand` (573)
| Command | Effect |
|---|---|
| `/claude <task>` | Owner: full `claude.exe` agent. Incoming (if `/claude-enable`d): sandboxed Groq/Gemini chatbot. |
| `/claude-enable` / `/claude-disable` | Allow/block *incoming* `/claude` in this chat (persists to `claude-enabled.json`). |
| `/claude-model haiku\|sonnet\|opus\|<id>` | Switch the owner agent model (persists to `claude-settings.json`; controls token spend). |
| `/claude-status` | Show model + guest key presence + enabled chats (to your own chat). |
| `/claude-webui` | Reply with the Web UI URL on the tailnet. |
| `/claude-help` | List all commands. |
| `/claude-pending` / `/claude-confirm [id]` / `/claude-deny [id]` | List / approve / reject queued approvals (an approval may carry a prompt that runs on confirm). |
| `/claude-ongoing` / `/claude-cancel <id>` | Live job dashboard / kill a running job (→ `handleOngoingCommand`). |
| `/claude-override` | (incoming) start the override-auth flow. (owner) view override status. |
| `/claude-override-setpass <pass>` / `-list` / `-revoke [chatId]` | Manage override-contact access (persists to `override-contacts.json`). |

### AI passthrough → `handleAICommand` (397)
| Command | Effect |
|---|---|
| `/grok <prompt>` | Direct Groq (or xAI Grok) reply — works even when Claude is rate-limited. |
| `/gemini <prompt>` | Direct Gemini reply. |

### Forms → `handleFillCommand` (1279) — see [whatsapp-features.md](whatsapp-features.md)
`/fill <url>`, `/fill-confirm`, `/fill-cancel`.

### Email → `handleEmailCommand` (1348) — forwards to gmail-monitor (8093)
`/email-important <id>`, `/email-spam <id>`, `/email-poll`, `/email-pause`, `/email-resume`, `/email-status`.

### Memory → `handleMemoryCommand` (1444) — forwards to memory-store (8094)
`/memory <q>` (= `/memory-search`), `/note <text>` (= `/remember`), `/memory-stats`, `/memory-clear-last`.

### Research / Notion / Calendar (each dispatches a Claude task with the right MCP tools)
`/research <q>` (1518) · `/notion <q>` / `/notion add <title> | <content>` (1543) ·
`/cal today|tomorrow|week` / `/cal add <event>` (1884).

### Groups → `handleGroupCommand` (2016)
`/group-watch`, `/group-status`, `/group-summary [name]`, `/group-actions [name]`.

### Price → `handleTrackCommand` (2105) — forwards to price-tracker (8095)
`/track <url> [at <price>]`, `/tracks`, `/untrack <id>`, `/price-check`.

### Documents → `handleDocCommand` (1736)
`/doc <title>` (+attachment), `/doc search <q>`, `/doc list`, `/doc notion <title>`.

### Reminders → `handleRemindCommand` (2233)
`/remind <natural language>`, `/reminders`, `/remind cancel <id>`.

### Briefings → `handleBriefingCommand` (2369)
`/briefing status|on|off`, `/briefing morning|evening`, `/briefing set morning|evening HH:MM`.

### Digital twin → `handleTwinCommand` (2555)
`/twin-on <name>`, `/twin-off <name>`, `/twin-status`, `/twin-refresh <name>`,
`/twin-voice-on <name>`, `/twin-voice-off <name>`.

> **Verify completeness when editing:**
> `rg -o "\"/[a-z-]+" whatsapp-mcp/index.js | sort -u` lists every literal command string.

---

## Spawning the agent

| Function | ~line | Signature | Role |
|---|---|---|---|
| `spawnClaude` | 1068 | `(chatId, chat, prompt, model, label="claude", opts={})` | Spawn `claude.exe` for an owner task: stdin = prompt, stdout = JSON `result`. Tracks the job, sends keepalive pings (first after 3 min, then every 90 s), supports multi-step via the `[AWAIT_APPROVAL]` marker. |
| `spawnClaudeText` | 1150 | `(prompt, model) → string\|null` | One-off text completion (45 s timeout). Used by the twin's complex tier and other quick asks. |

**Mechanics:** binary from `CLAUDE_EXE` (default `%APPDATA%/npm/node_modules/@anthropic-ai/
claude-code/bin/claude.exe`), cwd from `CLAUDE_WORKDIR`, model from `CLAUDE_MODEL`/override;
args `-p --output-format json --model <m> --permission-mode bypassPermissions` +
`--session-id`/`--resume`. See the protocol in [ARCHITECTURE.md](ARCHITECTURE.md).

**Multi-step resumption:** if a reply contains `[AWAIT_APPROVAL]`, the daemon strips it, calls
`opts.onPause`, and stores a `pendingContinuations` entry keyed by chat; `/claude ok [extra]`
resumes with the prior steps as context.

**Job tracking:** `activeJobs` (id → `{label, model, chatId, startedAt, status, child, …}`),
`recentJobs` (last 20), `jobCounter` (ids like `j1`, `j2`).

### Example: owner `/claude` flow
```
You ─► "/claude screenshot example.com and tell me the headline"
  handleClaudeCommand → spawnClaude(chatId, chat, prompt, model="opus", "claude")
    claude.exe (bypassPermissions, Playwright MCP) → navigates, screenshots, replies
  daemon ─► WhatsApp: the agent's answer (+ keepalive "⏳ still working…" if >3 min)
```

### Example: incoming guest flow
```
Friend ─► "/claude what's a good pasta recipe"   (only if you ran /claude-enable here)
  handleClaudeCommand → guest tier → Groq llama-3.1-8b-instant (no tools, no machine access)
  daemon ─► WhatsApp: a plain chat answer
```

---

## HTTP control API (port 8091, loopback)

Consumed by the `whatsapp-bridge` MCP, the Web UI's `/api/wa/*` proxy, and the other daemons
(gmail/price post here to send messages).

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | `{ready, needsQR, status}` |
| POST | `/send` | `{chatId, message}` → send text |
| POST | `/send-media` | `{chatId, filePath, caption?}` → send a file/image |
| POST | `/notify-owner` | `{message}` → DM your Saved Messages |
| POST | `/chats` | `{limit?}` → recent chats |
| POST | `/search-contacts` | `{query}` → contact matches |
| POST | `/queue-approval` | `{label, description, chatId?, prompt?, model?}` → register a 10-min approval; returns `{ok, id, expiresIn}` |
| GET | `/approval-status/:id` | poll `{id, status}` |
| GET | `/approvals` | list pending approvals |
| POST | `/approvals/resolve` | `{id?, action:"confirm"\|"deny"}` |
| GET | `/jobs` | `{model, running[], recent[]}` |
| POST | `/jobs/cancel` | `{id}` → kill a job |
| GET | `/override` | `{passwordSet, contacts[]}` |
| POST | `/override/revoke` | `{chatId?}` (null = all) |

### Example
```bash
curl -s http://127.0.0.1:8091/status
curl -s -X POST http://127.0.0.1:8091/send \
  -H 'content-type: application/json' \
  -d '{"chatId":"123456@c.us","message":"hi from the daemon"}'
```

---

## MCP tool set (only when `WA_DAEMON` is unset)

When run as a stdio MCP server, the daemon exposes ~35 `server.tool(...)` definitions Claude
can call directly. Grouped:

- **Read/send:** `get_status`, `get_chats`, `get_messages`, `send_message`, `send_media`,
  `forward_message`, `search_contacts`, `get_status_updates`.
- **Scheduling:** `schedule_message`, `list_scheduled`, `cancel_scheduled`.
- **Groups:** `create_group`, `get_group_info`, `add_group_participants`,
  `remove_group_participants`, `promote_group_admin`, `demote_group_admin`,
  `update_group_name`, `update_group_description`, `leave_group`.
- **Bulk:** `send_bulk_message` (with per-message delay).
- **Chat mgmt:** `archive_chat`, `unarchive_chat`, `mute_chat`, `unmute_chat`,
  `mark_chat_read`, `delete_message`, `send_reaction`.
- **Auto-reply:** `set_auto_reply`, `toggle_auto_reply`, `list_auto_replies`,
  `remove_auto_reply`, `set_ai_reply` (LLM-powered replies for a contact).

> In production the daemon runs with `WA_DAEMON=1`, so Claude reaches WhatsApp through the
> separate [`whatsapp-bridge` MCP](mcp-bridges.md) (which forwards to the 8091 API), not this
> in-process tool set. Both expose the same send/search surface.

## Auto-reply system

`globalAutoReplies` (keyword→reply for all chats), `autoReplies` (per-chat
`{name, aiEnabled, rules[]}`), `autoReplyEnabled` master toggle — all persisted to
`autoreply-data.json`. When a contact has `aiEnabled`, incoming messages get a short, natural
Gemini/Groq reply (`getGeminiReply`) instead of a fixed string. Bot commands and very short
messages are skipped.
