# CLAUDE.md — Project rules & orientation for Claude Code

This file is committed to the repo so that **any** Claude Code instance — on any machine,
on a fresh clone — starts informed instead of cold. Read it first. For deep detail see
[`docs/`](docs/README.md) and especially [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

> **On persistent memory:** Durable, evolving project knowledge that is *not* in the repo
> lives in the operator's **user-level** Claude memory
> (`~/.claude/projects/C--server-hub/memory/MEMORY.md` + linked files), loaded each session by
> a SessionStart hook. That memory is tied to the operator's machine and does **not** travel
> with a clone. This `CLAUDE.md` is the portable baseline that does. Separately, the
> `memory-store` daemon is *application* memory (WhatsApp/email content for the assistant
> features) — not Claude's coding rules. The repo also has `.claude/settings.local.json`
> (a permission allowlist only); note `.claude/` is gitignored.

## What this project is

A self-hosted "Full System Automation & Control" hub running 24/7 on a Windows 11 laptop,
controllable from anywhere over a private Tailscale network via three surfaces: a **Web UI**,
**WhatsApp** commands, and **SSH**. Everything is powered by the operator's **Claude Code Max
subscription** (the `claude.exe` CLI is spawned server-side) — there is deliberately **no paid
Anthropic API key** for the agent.

The repo must be cloned to **`C:\server-hub`** (scripts assume this absolute path).

## Component & port map

| Component | Dir | Process | Port | Role |
|---|---|---|---|---|
| Web UI | `webui/` | PM2 `hub-webui` | 8088 (Tailscale) | Browser cockpit → spawns `claude.exe` |
| WhatsApp daemon | `whatsapp-mcp/` | PM2 `whatsapp-mcp` | 8091 (loopback) | Owns the single WhatsApp Web connection; `/claude` + features |
| Memory store | `memory-store/` | PM2 `memory-store` | 8094 (loopback) | SQLite + FTS5 persistent app memory |
| Gmail monitor | `gmail-monitor/` | PM2 `gmail-monitor` | 8093 (loopback) | Polls inboxes, classifies, WhatsApp digest |
| Price tracker | `price-tracker/` | PM2 `price-tracker` | 8095 (loopback) | Playwright price scraper + drop alerts |
| Calendar bridge | `calendar-bridge/` | on-demand stdio MCP | — | Google Calendar MCP tools |
| MCP bridges | `mcp/` | on-demand stdio MCP | — | Thin proxies: whatsapp/memory/gmail/notion + Playwright |
| TTS service | `whatsapp-mcp/tts-service/` | optional Python | 5050 (loopback) | F5-TTS voice notes for the digital twin |

PM2 registry: [`ecosystem.config.js`](ecosystem.config.js). Playwright MCP and the stdio
bridges are **not** PM2 services — `claude.exe` spawns them on demand (≈0 idle RAM).

## Operating rules (honor these)

- **8 GB RAM ceiling.** The production server is an 8 GB laptop. Keep deps zero/minimal,
  set PM2 `max_memory_restart`, and use headless/`--no-sandbox` browser flags. The Web UI
  server is intentionally near-dep-free (only `ssh2` + `ws`, for the SSH terminal bridge);
  `memory-store` uses Node's built-in `node:sqlite` (no npm deps). Don't add heavy frameworks.
- **PowerShell scripts must be pure ASCII.** PS 5.1 breaks on smart quotes / em-dashes /
  non-breaking spaces. Keep `scripts/*.ps1` to plain ASCII.
- **Prefer winget / direct download** over `Add-WindowsCapability` (it hangs on Windows
  Update). OpenSSH was installed from the Win32-OpenSSH GitHub release for this reason.
- **Checkpoint working state.** After each phase or major feature: commit, push, and tag, so
  a known-good state is never lost. Conventional-commit style (`feat(twin): …`).
- **Spawn the native `claude.exe` directly** (shell:false), not `claude`/`claude.cmd` —
  going through cmd→powershell fails under PM2/background launch (EPERM). Feed the user
  message via **stdin as stream-json**, never as argv. See `docs/ARCHITECTURE.md` for the
  exact protocol and the `res.on('close')` (not `req.on('close')`) gotcha.

## Security gates (do not work around)

- The Claude Code auto-mode **classifier blocks this agent** from (a) starting the
  network-exposed `bypassPermissions` services under PM2 and (b) spawning a nested
  `bypassPermissions` claude. Those are the **operator's** to run in their own elevated
  terminal — that is them authorizing their own machine. Don't try to bypass this.
- Network exposure is **Tailscale-only** (WireGuard); nothing is on the public internet.
  Web UI = password + HttpOnly cookie. Daemon control ports (8091/8093/8094/8095) bind
  **127.0.0.1 only**. Incoming WhatsApp `/claude` is a **sandboxed Groq/Gemini chatbot**
  (zero machine access), never the real agent.

## Secrets — never commit (already gitignored)

`.env` / `.env.*`, `whatsapp-mcp/.wwebjs_auth/` + `.wwebjs_cache/`, all `*/tokens/` (OAuth),
`*.db` (`memory.db`, `prices.db`, `reminders.db`), and runtime `*.json` (auto-reply, twin
chats, conversations, usage logs, `claude-tasks.json`). The built `webui/dist/` **is** shipped
(so the server can pull-and-run). See [`docs/runtime-files.md`](docs/runtime-files.md).

## Manual steps that cannot be scripted (operator-only)

Claude Code install + `/login`, Tailscale login, WhatsApp QR scan, obtaining API keys
(Groq/Gemini/Google OAuth client), and running the elevated `scripts/setup.ps1`. These are
intentional and must be done by the operator.
