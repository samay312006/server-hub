# Scripts, PM2 & the Console-Tasks Hook

## `ecosystem.config.js` — PM2 registry

Defines the five long-lived apps with paths derived from `__dirname` (so the repo works wherever
cloned), 8 GB-sized memory caps, and per-app log files under `logs/`:

| App | script (cwd) | cap | env |
|---|---|---|---|
| `hub-webui` | `server.js` (`webui/`) | 200M | `NODE_ENV=production` |
| `whatsapp-mcp` | `index.js` (`whatsapp-mcp/`) | 700M | `+ WA_DAEMON=1, HUB_WEBUI_PORT=8088` |
| `memory-store` | `index.js` (`memory-store/`) | 150M | `NODE_ENV=production` |
| `gmail-monitor` | `index.js` (`gmail-monitor/`) | 150M | `NODE_ENV=production` |
| `price-tracker` | `index.js` (`price-tracker/`) | 300M | `NODE_ENV=production` |

Playwright MCP and the stdio bridges are deliberately **not** here — Claude spawns them on
demand. Common ops: `pm2 start ecosystem.config.js`, `pm2 save`, `pm2 restart <name>`,
`pm2 logs <name>`, `pm2 monit`.

## `scripts/*.ps1` — provisioning (Windows, mostly elevated)

> All must be **pure ASCII** — PS 5.1 breaks on smart quotes/em-dashes. Prefer winget /
> direct-download over `Add-WindowsCapability` (it hangs on Windows Update).

| Script | Elevated | Purpose |
|---|---|---|
| `setup.ps1` | yes | One-shot orchestrator: runs the phase steps, installs Tailscale + app deps + the Playwright browser, registers MCPs at user scope, generates the Web UI password, starts the WhatsApp daemon, prints the remaining manual steps. |
| `phase1-optimize.ps1` | yes | Windows tuning for an always-on headless server. |
| `phase1-install.ps1` | yes | Core toolchain via winget: Node LTS, Python 3.12, Git, Windows Terminal; PATH + npm config. |
| `phase1-ssh.ps1` | yes | Install/configure Windows OpenSSH (from the Win32-OpenSSH GitHub release, not the Windows capability). |
| `phase1-pm2.ps1` | yes | `npm i -g pm2` + `pm2-windows-startup` (boot persistence) + `pm2 save`. |
| `phase2-ssh-keys.ps1` | yes | SSH key infrastructure for multi-device access. |
| `phase3-webui.ps1` | yes | Deploy the Web UI: generate `.env` (random password, kept if present), add a Windows Firewall rule for TCP 8088 scoped to the Tailscale CIDR (`100.64.0.0/10`), smoke-test, `pm2 start … --only hub-webui`, print the URL. |
| `phase4-mcp.ps1` | yes | `npm install` in `mcp/`, install Playwright Chromium, register the whatsapp + playwright MCPs at user scope, (re)start the WhatsApp daemon, print the QR path. |

These map to the project's historical phases (1 base, 2 Tailscale/SSH, 3 Web UI, 4 MCP). Steps
that **cannot** be scripted are the operator's: Claude login, Tailscale login, WhatsApp QR scan,
and obtaining API keys.

## `scripts/sync-claude-tasks.js` — the Console-Tasks hook

A tiny Node script wired to **user-level** Claude Code hooks (in `~/.claude/settings.json`,
**not** in this repo). It reads a hook payload from stdin and maintains
`C:\server-hub\claude-tasks.json`, which the Web UI dashboard's "Console Tasks" card displays.

| Hook event | Effect |
|---|---|
| `UserPromptSubmit` | Upsert a `console-<session_id>` task as **running** (covers every console session, even ones that never call `TaskCreate`). |
| `Stop` / `SubagentStop` | Mark that session's task **completed**. |
| `PostToolUse` on `TaskCreate`/`TaskUpdate`/`TaskStop` | Richer per-task entries; maps tool statuses via `STATUS_MAP` (`in_progress`/`pending`→running, `deleted`/`cancelled`→cancelled, etc.). |

Tasks whose `finishedAt` is older than **2 hours** are pruned on each run. Because hook configs
are snapshotted at session start, edits only apply to **newly started** sessions — and the
permission classifier blocks Claude from editing `~/.claude/settings.json` hooks without
explicit operator approval.
