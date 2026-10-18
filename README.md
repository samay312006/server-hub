<div align="center">

# 🛰️ server-hub

**Your own always-on AI control centre. Talk to Claude Code from your phone over WhatsApp or a browser, from anywhere, on a private network.**

![Windows](https://img.shields.io/badge/Windows-11-0078D4?logo=windows&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=node.js&logoColor=white)
![Claude Code](https://img.shields.io/badge/powered_by-Claude_Code-D97757?logo=anthropic&logoColor=white)
![Tailscale](https://img.shields.io/badge/network-Tailscale-242424?logo=tailscale&logoColor=white)
![PM2](https://img.shields.io/badge/process_manager-PM2-2B037A?logo=pm2&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-50%2B_commands-25D366?logo=whatsapp&logoColor=white)

[Features](#-features) · [Components](#components) · [Setup guide](#-setup-guide) · [WhatsApp commands](#whatsapp-commands-summary) · [Security](#security) · [Troubleshooting](#%EF%B8%8F-troubleshooting) · [Docs](docs/README.md)

</div>

---

A self-hosted **automation & AI control hub** running 24/7 on a Windows laptop. Drive it from
anywhere — **browser, WhatsApp, or SSH** — over your private **Tailscale** network, all powered
by your **Claude Code subscription** (no separate Anthropic API key for the agent).

It started as "Claude in a browser over VPN" and grew into a small platform: a multi-device
web cockpit, a WhatsApp assistant with 50+ commands and a persona-mimicking digital twin, a
searchable memory store, an email-importance monitor, a price tracker, and Google
Calendar/Notion integration — each a small service the agent can reach.

## ✨ Features

- 🌐 **Browser cockpit.** Chat with Claude Code, browse files, run git, open a terminal, mirror live sessions and manage several machines from one web UI.
- 💬 **WhatsApp agent.** Text `/claude <task>` from your phone and the hub does it on your PC, then replies with the result. More than 50 commands: reminders, calendar, email, notes, price tracking, research, Notion and group summaries.
- 🛡️ **Safe for other people.** Messages from anyone else only ever reach a sandboxed chatbot with no access to your machine, and it's off by default for every chat.
- 🧠 **Searchable memory.** A SQLite + full-text-search store the assistant can save to and recall from.
- 📧 **Inbox triage.** Polls Gmail, flags what matters and sends you a WhatsApp digest.
- 💸 **Price-drop alerts.** Headless-browser price scraping with notifications.
- 📅 **Google Calendar and Notion** integrations.
- 🌅 **Morning and evening briefings**, sent to WhatsApp on a schedule.
- 🪞 **Digital twin (optional).** Learns how you text a specific contact and replies in your style, with optional voice notes (F5-TTS).
- 🔒 **Private by design.** Everything travels over Tailscale (WireGuard). Nothing is exposed to the public internet.
- 💰 **No separate API bill for the agent.** It runs on your Claude Code subscription.

> **New here? Read the docs.** This README is the map; the full, function-level reference lives
> in **[`docs/`](docs/README.md)**. If you're a Claude Code agent, start with
> **[`CLAUDE.md`](CLAUDE.md)**.

---

## Components

| Component | Dir | Process · Port | What it does | Docs |
|---|---|---|---|---|
| Web UI | `webui/` | PM2 · 8088 | Browser cockpit: chat, git, files, live session mirror, devices, skills, tasks, terminal | [server](docs/webui-server.md) · [frontend](docs/webui-frontend.md) |
| WhatsApp daemon | `whatsapp-mcp/` | PM2 · 8091 | Owns the WhatsApp connection; `/claude` + 50+ commands; digital twin | [daemon](docs/whatsapp-daemon.md) · [features](docs/whatsapp-features.md) |
| Memory store | `memory-store/` | PM2 · 8094 | SQLite + FTS5 searchable memory | [doc](docs/memory-store.md) |
| Gmail monitor | `gmail-monitor/` | PM2 · 8093 | Inbox polling + importance classifier + digest | [doc](docs/gmail-monitor.md) |
| Price tracker | `price-tracker/` | PM2 · 8095 | Playwright price scraper + drop alerts | [doc](docs/price-tracker.md) |
| Calendar bridge | `calendar-bridge/` | on-demand MCP | Google Calendar tools | [doc](docs/calendar-bridge.md) |
| MCP bridges | `mcp/` | on-demand MCP | whatsapp/memory/gmail/notion proxies + Playwright | [doc](docs/mcp-bridges.md) |
| Provisioning | `scripts/`, `ecosystem.config.js` | — | PM2 registry + Windows setup scripts | [doc](docs/scripts-and-pm2.md) |

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it all fits together and the
`claude.exe` stream-json protocol, and **[docs/PORTS-AND-ENV.md](docs/PORTS-AND-ENV.md)** for
every port and environment variable.

---

## 🚀 Setup guide

> The full operator manual is **[INSTRUCTIONS.md](INSTRUCTIONS.md)**. This is the condensed walkthrough.

### What you need

| | Requirement |
|---|---|
| 💻 Host | A **Windows 11** PC or laptop that can stay on. 8 GB RAM is enough. |
| 🤖 Claude | A Claude subscription with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in |
| 🟢 Node.js | **22.5 or newer** (the memory store uses the built-in `node:sqlite`). `setup.ps1` installs it if missing. |
| 🌐 Tailscale | A free [Tailscale](https://tailscale.com) account, on the host **and** on your phone |
| 📱 WhatsApp | A WhatsApp account to link as a "linked device" (optional, but it's the best part) |
| 🔑 Optional keys | [Groq](https://console.groq.com/keys) (free) and/or [Gemini](https://aistudio.google.com/app/apikey) for the guest chatbot, `/grok` and `/gemini`; a Google Cloud OAuth client for Gmail and Calendar |

### Step 1: Install Claude Code and log in

```powershell
npm install -g @anthropic-ai/claude-code
claude          # then type /login and sign in with your subscription
```

### Step 2: Clone to `C:\server-hub`

The scripts expect this exact path.

```powershell
git clone https://github.com/samay312006/server-hub.git C:\server-hub
```

### Step 3: Run the one-shot installer (elevated PowerShell)

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
C:\server-hub\scripts\setup.ps1
```

It installs Node, Python, Git, OpenSSH, PM2 and Tailscale, installs every service's dependencies and the Playwright browser, registers the MCP servers with Claude Code, and starts everything under PM2 so it auto-starts on boot.
**Save the Web UI password it prints.**

### Step 4: Connect Tailscale

```powershell
tailscale up        # log in via the browser
tailscale ip -4     # note this IP: it's your hub's address
```

Install Tailscale on your phone and log in with the **same account**.

### Step 5: Link WhatsApp

```powershell
pm2 logs whatsapp-mcp
```

When you see `QR SCAN NEEDED`, open `C:\server-hub\whatsapp-mcp\qr.png` and scan it from WhatsApp → **Settings ▸ Linked devices**. Wait for `WhatsApp ready`.

### Step 6: Configure (each service reads its own `.env`)

```powershell
cd C:\server-hub
copy whatsapp-mcp\.env.example whatsapp-mcp\.env      # GROQ_API_KEY, GEMINI_API_KEY, PRIMARY_CALENDAR_ACCOUNT
copy webui\devices.example.json webui\devices.json     # optional: your other machines (Tailscale IPs)
pm2 restart all
```

Every variable is documented in **[docs/PORTS-AND-ENV.md](docs/PORTS-AND-ENV.md)**.

### Step 7 (optional): Gmail and Calendar

```powershell
node C:\server-hub\gmail-monitor\setup.js add you@gmail.com      # browser OAuth
node C:\server-hub\calendar-bridge\setup.js add you@gmail.com    # browser OAuth
pm2 restart gmail-monitor
```

### Step 8: Try it ✅

- **Browser:** open `http://<tailscale-ip>:8088` on any device in your tailnet and log in with the saved password.
- **WhatsApp:** message yourself `/claude-help`, then something like `/claude what's using the most disk space?`
- **Status:** `pm2 list` should show `hub-webui`, `whatsapp-mcp`, `memory-store`, `gmail-monitor` and `price-tracker` as online.

---

## WhatsApp commands (summary)

You (the owner) always get the **full agent**; incoming messages only ever get a **sandboxed
chatbot**. Full table: [docs/whatsapp-daemon.md](docs/whatsapp-daemon.md).

- **Agent:** `/claude <task>`, `/claude-model haiku|sonnet|opus`, `/claude-status`,
  `/claude-enable`/`-disable`, `/claude-webui`, `/claude-ongoing`, `/claude-cancel`,
  `/claude-override*`, `/claude-help`
- **Direct AI:** `/grok <q>`, `/gemini <q>` (work even when Claude is rate-limited)
- **Memory:** `/memory <q>`, `/note <text>`, `/memory-stats`
- **Email:** `/email-important|spam|poll|pause|resume|status`
- **Calendar:** `/cal today|tomorrow|week`, `/cal add <event>`
- **Reminders:** `/remind <natural language>`, `/reminders`, `/remind cancel <id>`
- **Price:** `/track <url> [at <price>]`, `/tracks`, `/untrack <id>`, `/price-check`
- **Docs:** `/doc <title>` (+attachment), `/doc search|list|notion`
- **Groups:** `/group-watch|status|summary|actions`
- **Research / Notion:** `/research <q>`, `/notion <q>`, `/notion add <title> | <content>`
- **Briefings:** `/briefing on|off|morning|evening|set …`
- **Digital twin:** `/twin-on <name>`, `/twin-off`, `/twin-status`, `/twin-refresh`,
  `/twin-voice-on|off`

---

## Security

- **Tailscale-only** (WireGuard) — nothing exposed to the public internet. Daemon control
  ports (8091/8093/8094/8095) bind `127.0.0.1` only; the Web UI (8088) is firewalled to the
  Tailscale CIDR.
- Web UI: password + HttpOnly session cookie. Cross-device: shared `HUB_DEVICE_TOKEN` header.
- Incoming WhatsApp `/claude` is a **sandboxed Groq/Gemini chatbot** — no machine access, no
  code, injection-proof — and **off per chat by default**.
- All secrets and personal data (`.env` files, the WhatsApp session, OAuth tokens, runtime
  DBs/JSON, `devices.json`, briefing settings) are **gitignored**. Copy the `*.example` files to get started. See [docs/runtime-files.md](docs/runtime-files.md).

> ⚠️ **Use the digital twin responsibly.** It replies to real people as you. Only enable it for
> contacts who are fine with that, and remember WhatsApp's terms apply to automated use of your account.

## 🛠️ Troubleshooting

| Problem | Fix |
|---|---|
| MCP tools missing in Claude Code | `claude mcp list` should show `whatsapp` and `playwright` as ✓. If not, re-run the MCP block in `scripts/setup.ps1`. |
| WhatsApp keeps asking for a QR code | Make sure only **one** `whatsapp-mcp` is running (`pm2 list`). Another WhatsApp Web client on the same account conflicts with it. |
| `/claude` is silently ignored | Check `pm2 logs whatsapp-mcp`. If it says `QR SCAN NEEDED`, scan again. |
| Web UI unreachable | `pm2 list` should show `hub-webui` online, and `tailscale status` should show your device on the tailnet. |
| Memory store won't start | Check `node -v` is **22.5+** (`node:sqlite` is required). |
| Guest replies, `/grok` or `/gemini` don't work | Add `GROQ_API_KEY` and/or `GEMINI_API_KEY` to `whatsapp-mcp/.env`, then `pm2 restart whatsapp-mcp`. |
| Lost the Web UI password | Set `HUB_PASSWORD` in `webui/.env`, then `pm2 restart hub-webui`. |

## Persistent memory & Claude rules

- **In-repo** Claude orientation/rules now live in **[`CLAUDE.md`](CLAUDE.md)** (committed, so a
  fresh clone or any new Claude instance starts informed).
- **Application memory** (WhatsApp/email content for the assistant) is the `memory-store`
  daemon — see [docs/memory-store.md](docs/memory-store.md).
- The operator's evolving, machine-local project notes live outside the repo in user-level
  Claude memory and don't travel with a clone — which is exactly why `CLAUDE.md` exists.

---

## Hardware targets

| Machine | Spec | Role |
|---|---|---|
| Server | Lenovo IdeaPad, i5 11th Gen, 8 GB RAM | Always-on host |
| Test/Dev | 16 GB RAM, RTX 4060 | Validation before server deploy |

The 8 GB ceiling drives the design: zero/minimal dependencies, PM2 memory caps, headless
browsers. Keep it that way.

## Stack

Node.js · [whatsapp-web.js](https://wwebjs.dev) · [Playwright](https://playwright.dev) ·
[Claude Code](https://github.com/anthropics/claude-code) · React + Vite + Three.js · F5-TTS ·
PM2 · Tailscale · `node:sqlite` (FTS5).
