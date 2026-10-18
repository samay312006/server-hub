# Ports & Environment Variables

## Ports

| Port | Bound to | Process | Purpose |
|---|---|---|---|
| 8088 | `0.0.0.0` (firewalled to Tailscale `100.64.0.0/10`) | `hub-webui` | Web UI |
| 8091 | `127.0.0.1` | `whatsapp-mcp` | WhatsApp daemon control API |
| 8093 | `127.0.0.1` | `gmail-monitor` | Gmail monitor API |
| 8094 | `127.0.0.1` | `memory-store` | Memory store API |
| 8095 | `127.0.0.1` | `price-tracker` | Price tracker API |
| 5050 | `127.0.0.1` | `tts_server.py` | F5-TTS voice synthesis (optional) |
| 4321 | `localhost` | transient | Google OAuth redirect during `setup.js` flows |
| 22 | (Tailscale) | Windows OpenSSH | SSH / Web terminal target |

Only **8088** and **22** are reachable across the tailnet; everything else is loopback-only.

## Environment variables by module

Each module reads a local `.env` (no shared root `.env`). All `.env*` files are gitignored.

### `webui/.env` — Web UI (`webui/server.js`)
| Var | Default | Purpose |
|---|---|---|
| `HUB_PORT` | `8088` | Listen port |
| `HUB_BIND` | `0.0.0.0` | Bind address |
| `HUB_PASSWORD` | auto-generated | Owner login password |
| `HUB_GUEST_PASSWORD` | (unset) | Optional guest login |
| `HUB_MODEL` | `opus` | Default agent model |
| `HUB_WORKDIR` | `C:\server-hub` | Active project dir for the agent |
| `HUB_PERMISSION_MODE` | `bypassPermissions` | Claude permission policy |
| `HUB_TURN_TIMEOUT_MS` | `600000` | Per-turn timeout |
| `HUB_ROLE` | `hub` | Informational node role |
| `HUB_DEVICE_ID` | hostname | This node's id in `devices.json` |
| `HUB_DEVICE_TOKEN` | (blank → cross-device disabled) | Shared secret for `/agent/*` |
| `HUB_CLAUDE_EXE` | auto-resolved | Path to `claude.exe` |
| `HUB_SSH_USER` | — | Default SSH user for the terminal bridge |
| `WA_CONTROL_PORT` | `8091` | Where to reach the WhatsApp daemon |

### `whatsapp-mcp/.env` — WhatsApp daemon (`whatsapp-mcp/index.js`)
| Var | Default | Purpose |
|---|---|---|
| `WA_DAEMON` | (set to `1` by PM2) | Daemon mode: HTTP control API + `/claude`, no stdio MCP |
| `WA_CONTROL_PORT` | `8091` | Control API port |
| `HUB_WEBUI_PORT` | `8088` | So `/claude-webui` reports the right URL |
| `HUB_WEBUI_URL` | auto (Tailscale IP) | Override the reported Web UI URL |
| `CLAUDE_EXE` | `%APPDATA%/npm/.../claude.exe` | Path to the agent binary |
| `CLAUDE_WORKDIR` | repo root | Working dir for owner `/claude` |
| `CLAUDE_MODEL` | `sonnet` | Owner agent model (also set via `/claude-model`) |
| `CLAUDE_OVERRIDE_PASSWORD` | (empty) | Password for the override-contact tier |
| `GROQ_API_KEY` | — | `/grok`, guest chatbot, reminder/action NL parsing |
| `GEMINI_API_KEY` | — | `/gemini`, twin medium tier, guest fallback |
| `XAI_API_KEY` / `GROK_MODEL` | — / `grok-3` | Optional xAI Grok instead of Groq |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Groq model |
| `MEMORY_STORE_URL` | `http://127.0.0.1:8094` | Memory daemon |
| `GMAIL_MONITOR_URL` | `http://127.0.0.1:8093` | Gmail daemon |
| `PRICE_TRACKER_URL` | `http://127.0.0.1:8095` | Price daemon |

### `memory-store/.env`
| Var | Default | Purpose |
|---|---|---|
| `MEMORY_STORE_PORT` | `8094` | Listen port (loopback) |

### `gmail-monitor/.env`
| Var | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | OAuth app credentials |
| `GMAIL_ACCOUNTS` | — | Comma-separated monitored inboxes |
| `POLL_INTERVAL_MINUTES` | `15` | Poll cadence |
| `GMAIL_MONITOR_PORT` | `8093` | Listen port |
| `WA_CONTROL_URL` | `http://127.0.0.1:8091` | Where to send digests |
| `OWNER_CHAT_ID` | — | WhatsApp chat that receives the digest |
| `GROQ_API_KEY` / `GEMINI_API_KEY` | — | Optional email summarization |
| `SENDER_WHITELIST` | — | Always-important senders |
| `IMPORTANT_KEYWORDS` | built-in list | Subject keywords that flag importance |

### `price-tracker/.env`
| Var | Default | Purpose |
|---|---|---|
| `PRICE_TRACKER_PORT` | `8095` | Listen port |
| `PRICE_CHECK_INTERVAL_MINUTES` | `30` | Poll cadence |
| `WA_CONTROL_URL` | `http://127.0.0.1:8091` | Where to send drop alerts |
| `OWNER_CHAT_ID` | — | Fallback alert chat |

### `calendar-bridge/.env`
| Var | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | OAuth app (shared with gmail-monitor) |
| `CALENDAR_ACCOUNTS` | — | Comma-separated authorized accounts |
| `TIMEZONE` | `Asia/Kolkata` | Default event timezone |

### `mcp/.env` — stdio bridges
| Var | Default | Purpose |
|---|---|---|
| `WA_CONTROL_URL` | `http://127.0.0.1:8091` | whatsapp-bridge target |
| `MEMORY_STORE_URL` | `http://127.0.0.1:8094` | memory-bridge target |
| `GMAIL_MONITOR_URL` | `http://127.0.0.1:8093` | gmail-bridge target |
| `NOTION_TOKEN_<n>` / `NOTION_LABEL_<n>` | — | One pair per Notion workspace (1-based) |
