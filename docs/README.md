# server-hub — Developer Documentation

Full, function-level reference for the server-hub automation platform. If you just want to
**run** the hub, start with the root [`README.md`](../README.md) and
[`INSTRUCTIONS.md`](../INSTRUCTIONS.md). If you want to **understand or modify the code**, you
are in the right place.

For Claude Code agents: read [`../CLAUDE.md`](../CLAUDE.md) first.

## How the docs are organised

| Doc | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System diagram, process model, the `claude.exe` stream-json protocol, two-tier `/claude`, multi-device proxy, security model |
| [PORTS-AND-ENV.md](PORTS-AND-ENV.md) | Every port and every environment variable, per module |
| [runtime-files.md](runtime-files.md) | Every runtime / config JSON and SQLite DB: shape + purpose (most are gitignored) |
| **WhatsApp** ||
| [whatsapp-daemon.md](whatsapp-daemon.md) | `whatsapp-mcp/index.js`: all 50+ slash commands, core functions, the HTTP control API (8091), the MCP tool set, job/approval queues |
| [whatsapp-features.md](whatsapp-features.md) | `whatsapp-mcp/features/*.js`, the digital twin, and the F5-TTS Python service |
| **Web UI** ||
| [webui-server.md](webui-server.md) | `webui/server.js`: the complete HTTP route table + helper functions + SSH terminal bridge |
| [webui-frontend.md](webui-frontend.md) | `webui/app/src/*.jsx`: React components, state, API layer, Three.js mascot, PWA |
| **Standalone daemons** ||
| [memory-store.md](memory-store.md) | SQLite+FTS5 memory daemon (8094): functions, HTTP API, schema |
| [gmail-monitor.md](gmail-monitor.md) | Inbox poller + importance classifier + digest (8093) |
| [price-tracker.md](price-tracker.md) | Playwright price scraper + drop alerts (8095) |
| [calendar-bridge.md](calendar-bridge.md) | Google Calendar stdio MCP server |
| **Glue** ||
| [mcp-bridges.md](mcp-bridges.md) | `mcp/*.js` stdio MCP bridges (whatsapp/memory/gmail/notion): tools + params |
| [scripts-and-pm2.md](scripts-and-pm2.md) | `scripts/*.ps1`, `sync-claude-tasks.js`, `ecosystem.config.js` |

## The 10-second mental model

```
Your devices ──Tailscale──► Windows laptop (24/7)
   Browser  ─► Web UI 8088 ─┐
   SSH      ─► OpenSSH 22    ├─► claude.exe (Max subscription, stream-json over stdin/stdout)
   WhatsApp ─► daemon 8091  ─┘        │
                                       ├─ Playwright MCP (on-demand headless browser)
                                       ├─ whatsapp / memory / gmail / notion / calendar MCP bridges
                                       └─ background daemons: memory-store 8094, gmail 8093, price 8095
```

Every surface ultimately drives the same `claude.exe` agent. The daemons own scarce/singleton
resources (the one WhatsApp connection, the SQLite DBs, the browser) and expose **loopback
HTTP APIs**; the thin **stdio MCP bridges** let a per-session `claude.exe` reach those daemons
without re-opening the resource. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Conventions used in these docs

- Function tables list `name`, `file:line` (approximate — daemon files change often; re-grep
  to confirm), `signature`, `role`, and notable side effects.
- "loopback" = bound to `127.0.0.1`, reachable only from the same machine.
- "owner" = a message the operator sent themselves (`msg.fromMe` on WhatsApp, or the
  password-authed owner cookie on the Web UI). "guest"/"incoming" = anyone else.
