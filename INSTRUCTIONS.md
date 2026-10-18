# server-hub — Setup & Operations

A self-hosted automation hub: control a Windows laptop 24/7 from anywhere via
**CLI (SSH)**, a **Web UI**, or **WhatsApp** — all powered by your Claude Code
subscription (no extra API key for the agent itself).

> **For full code documentation** (every service, function, route, and config
> file) see **[docs/](docs/README.md)**. This file is operations-focused.

> **If you are Claude Code reading this to set up the machine:** do the steps in
> order. You can run the non-elevated bits yourself (npm installs, MCP
> registration, editing `.env` files, verification). You **cannot** run the
> elevated/admin script or start the network-exposed services — those say
> **[USER]**; stop and ask the user to run them in their own elevated PowerShell.
> Authentication steps (Claude login, Tailscale login, WhatsApp QR) are always the
> user's to do. Don't try to work around these — they are intentional.

---

## 0. Prerequisites (manual)

1. **Windows 11.**
2. **Install Claude Code and log in** with your Claude subscription:
   ```powershell
   npm install -g @anthropic-ai/claude-code   # or the native installer
   claude            # then run /login inside it
   ```
3. **Clone this repo to `C:\server-hub`** (the scripts assume this location):
   ```powershell
   git clone <your-repo-url> C:\server-hub
   ```

## 1. One-shot setup  **[USER — elevated PowerShell]**

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
C:\server-hub\scripts\setup.ps1
```

This runs everything scriptable: Windows tuning, Node/Python/Git, OpenSSH, PM2,
Tailscale install, all app dependencies, the Playwright browser, MCP registration,
the Web UI (with a generated password) and the WhatsApp daemon. **Save the Web UI
password it prints.**

## 2. Finish the manual bits (the script reminds you)

1. **Tailscale** — connect this laptop to your tailnet:
   ```powershell
   tailscale up          # opens a browser to log in
   tailscale ip -4       # note this IP - it's how you reach the hub
   ```
   Install Tailscale on your phone/other devices and log into the **same account**.

2. **WhatsApp** — link the daemon to your WhatsApp:
   ```powershell
   pm2 logs whatsapp-mcp
   ```
   When it prints `QR SCAN NEEDED`, open `C:\server-hub\whatsapp-mcp\qr.png` and
   scan it in WhatsApp → **Linked Devices**. Wait for `WhatsApp ready`, then Ctrl+C.

3. **Groq key (for the incoming chatbot)** — get a free key at
   <https://console.groq.com/keys>, put it in `C:\server-hub\whatsapp-mcp\.env`:
   ```
   GROQ_API_KEY=gsk_your_key
   ```
   then `pm2 restart whatsapp-mcp`. (Your own `/claude` works without this; it only
   powers replies to *other* people's messages and the `/grok` / `/gemini` commands.)

Done. Everything auto-starts on boot from here on.

---

## How to use it

### Web UI
Open `http://<tailscale-ip>:8088` in any browser on your tailnet and log in with
the password from setup.

**Features:**
- **Sidebar** — conversation history (click any past chat to restore it), workflows, projects
- **Model selector** — dropdown in the header; change the AI model live without restart
- **Conversations** — every chat is saved automatically; switch between them from the sidebar
- **Workflows** — save named prompts (e.g. "Daily server check") and run them in one click
- **Projects** — switch the agent's working directory between different codebases/projects
- **Connectors** — view, add, and remove MCP servers via the Connectors button in the header
- **QR banner** — a red banner appears automatically if WhatsApp needs re-linking; polls every 30 s

### WhatsApp — `/claude` commands (you = owner)

| Command | Effect |
|---|---|
| `/claude <task>` | Run the full agent (browse, screenshot, files, etc.) |
| `/claude-enable` / `/claude-disable` | Allow / block *incoming* `/claude` in this chat |
| `/claude-status` | Show model, chatbot key, and enabled chats (sends to your own chat) |
| `/claude-model haiku\|sonnet\|opus` | Switch the agent's model (saves; controls cost) |
| `/claude-webui` | Get the Web UI link |
| `/claude-help` | List all commands |
| `/grok <prompt>` | Direct Groq AI query (works even when Claude is rate-limited) |
| `/gemini <prompt>` | Direct Gemini AI query |

- **You** (messages you send) always get the full Claude agent.
- **Incoming** messages only get a **sandboxed chatbot** (Groq/Gemini) — no machine
  access, no code, no data leakage — and only in chats you `/claude-enable`.
- If you hit Claude's rate limit, `/claude` replies with a clear message and reminds
  you to use `/grok` as a fallback.

### CLI
```powershell
ssh <your-windows-username>@<tailscale-ip>
```

---

## Starting / stopping / status

PM2 keeps everything alive and restarts on boot (via `pm2 save` + the Windows
startup hook from Phase 1). You normally never touch this.

```powershell
pm2 list                                        # status of all hub services
pm2 restart hub-webui                           # restart Web UI (e.g. after editing .env)
pm2 restart whatsapp-mcp                        # restart WhatsApp daemon
pm2 logs <name>                                 # tail logs
pm2 start C:\server-hub\ecosystem.config.js    # start all (if ever fully stopped)
```

The PM2 registry (`ecosystem.config.js`) defines five services:

| PM2 name | Port | Role |
|---|---|---|
| `hub-webui` | 8088 (Tailscale) | Web UI |
| `whatsapp-mcp` | 8091 (localhost) | WhatsApp daemon + `/claude` + digital twin |
| `memory-store` | 8094 (localhost) | SQLite + FTS5 searchable memory |
| `gmail-monitor` | 8093 (localhost) | Inbox polling + importance digest |
| `price-tracker` | 8095 (localhost) | Playwright price scraper + drop alerts |

`memory-store` needs no extra setup. `gmail-monitor` and `calendar-bridge` each need a
one-time OAuth authorization before first run:

```powershell
node C:\server-hub\gmail-monitor\setup.js add <your-email>      # browser OAuth, then pm2 restart gmail-monitor
node C:\server-hub\calendar-bridge\setup.js add <your-email>    # browser OAuth for /cal
```

`price-tracker` just needs `npm install` in its folder (for Playwright). See the per-service
docs under [docs/](docs/README.md) for env vars and HTTP APIs.

### WhatsApp session management
The daemon maintains a persistent WhatsApp Web session (no daily restart). Sessions
typically last weeks to months. If the session ever goes stale:

- The daemon **auto-detects** it (ready event doesn't fire within 3 min of auth)
- Automatically wipes the stale session and restarts to show a fresh QR
- The **Web UI shows a red banner** telling you to scan the new QR
- You can also watch: `pm2 logs whatsapp-mcp` — look for `📱 QR SCAN NEEDED`

### Change the Web UI's model
Use the model dropdown in the Web UI header — it saves automatically and survives
restarts. No `pm2 restart` needed.

---

## Architecture

```
Devices ──Tailscale──► [ laptop, 24/7 ]
  • Web UI  (webui/server.js, port 8088)  ─┐
  • SSH     (OpenSSH)                       ├─► claude CLI (your subscription)
  • WhatsApp(whatsapp-mcp daemon, port 8091)┘        │
                                                     ├─ Playwright MCP (on-demand browser)
                                                     ├─ MCP bridges ─► daemons below:
                                                     │     memory-store 8094 · gmail 8093
                                                     │     price-tracker 8095 · calendar · notion
                                                     └─ WhatsApp bridge MCP ─► daemon control API
```

Full architecture (process model, the claude.exe stream-json protocol, the two-tier
`/claude`, multi-device proxy): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Web UI** saves conversations to `webui/conversations/`, workflows to
`webui/workflows.json`, and projects to `webui/projects.json` — all gitignored.

Secrets (`.env`, WhatsApp session `.wwebjs_auth/`, runtime `*.json`) are gitignored
and never leave the machine.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| MCP not connected | `claude mcp list` — should show `whatsapp` and `playwright` as ✓. Re-run the MCP registration block in `scripts/setup.ps1` if missing. |
| WhatsApp keeps asking for QR | Make sure only ONE `whatsapp-mcp` runs (`pm2 list`). Claude Desktop running its own WA client would conflict. |
| Web UI unreachable | Confirm `pm2 list` shows `hub-webui` online and your device is on the tailnet (`tailscale status`). |
| `/claude` silently ignored | Check `pm2 logs whatsapp-mcp` — if you see `QR SCAN NEEDED`, re-scan the QR. |
| Web UI model resets after restart | The dropdown saves to `webui/hub-config.json` which is gitignored but persists on disk. Only resets if you delete that file. |
