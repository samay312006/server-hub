# MCP Stdio Bridges — `mcp/`

These are thin **stdio MCP servers** that Claude spawns per-session. They hold no state; each
forwards MCP tool calls to a persistent daemon's loopback HTTP API (so a per-session agent
never re-opens a singleton resource). All use `@modelcontextprotocol/sdk` + `zod`; each has a
tiny `call(path, method, body)` helper that `fetch`es the daemon and returns the raw JSON text
(and a friendly error if the daemon is down). Registered at **user scope** in `~/.claude.json`
so both the CLI and the Web UI inherit them.

`mcp/` deps: `@modelcontextprotocol/sdk`, `@notionhq/client`, `@playwright/mcp`, `zod`. The
Playwright MCP (`@playwright/mcp`) is also launched on demand (headless, isolated) but is not a
custom bridge file — it's the upstream package.

## `whatsapp-bridge.js` → WhatsApp daemon (8091)
| Tool | Params | Daemon endpoint |
|---|---|---|
| `whatsapp_status` | `{}` | `GET /status` |
| `send_message` | `{chatId, message}` | `POST /send` |
| `send_media` | `{chatId, filePath, caption?}` | `POST /send-media` |
| `get_chats` | `{limit=20}` | `POST /chats` |
| `search_contacts` | `{query}` | `POST /search-contacts` |

## `memory-bridge.js` → memory-store (8094)
| Tool | Params | Endpoint |
|---|---|---|
| `memory_search` | `{query?, person?, dateFrom?, dateTo?, topic?, type?, limit=20}` (NL dates OK) | `POST /search` |
| `memory_add` | `{content, type="note", person?, topic?, summary?, eventDate?}` (adds `source:"manual"`) | `POST /add` |
| `memory_recent` | `{limit=20, person?, type?}` | `GET /recent` |
| `memory_stats` | `{}` | `GET /stats` |

## `gmail-bridge.js` → gmail-monitor (8093)
| Tool | Params | Endpoint |
|---|---|---|
| `gmail_list_accounts` | `{}` | `GET /accounts` |
| `gmail_search` | `{query, account?, maxResults=15}` | `POST /search` |
| `gmail_get_email` | `{id, account}` | `POST /get-message` |
| `gmail_status` | `{}` | `GET /status` |
| `gmail_poll_now` | `{}` | `POST /poll-now` |
| `gmail_mark_feedback` | `{shortId, action}` | looks up the sender via `/recent-emails`, then `POST /feedback` |

## `notion-bridge.js` → Notion API directly (multi-workspace)
Reads `NOTION_TOKEN_<n>` / `NOTION_LABEL_<n>` pairs from `mcp/.env` (one Notion internal
integration per workspace, 1-based index). Not a daemon proxy — it calls Notion directly.

| Tool | Params | Role |
|---|---|---|
| `notion_workspaces` | `{}` | List configured workspaces. |
| `notion_search` | `{query, filter?, workspace_index?, limit=10}` | Search pages/databases. |
| `notion_get_page` | `{page_id, workspace_index?, max_blocks=50}` | Page + blocks (accepts URL or UUID). |
| `notion_create_page` | `{workspace_index, parent_id, parent_type, title, content?}` | Create under a parent. |
| `notion_append_to_page` | `{page_id, workspace_index?, text, heading?}` | Append blocks. |
| `notion_list_databases` | `{workspace_index?}` | List databases. |
| `notion_query_database` | `{database_id, workspace_index?, limit=20}` | Query entries. |

Helpers: `cleanId(input)` (URL/UUID±dashes/32-hex → no-dash UUID), `pageTitle(item)`,
`fmtPage(item)`, `fmtBlock(block)`.

> **Calendar** is a *direct* MCP server, not a proxy bridge — see
> [calendar-bridge.md](calendar-bridge.md).
