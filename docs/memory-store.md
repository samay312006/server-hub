# Memory Store — `memory-store/`

A persistent, searchable memory daemon. It is the **application** memory for the assistant
features (WhatsApp conversations, facts, documents, action items) — not Claude's coding rules.
Uses Node's built-in `node:sqlite` (Node 22.5+) with an **FTS5** full-text index, so it has
**zero npm dependencies**.

- **Process:** PM2 `memory-store`, `max_memory_restart: 150M`, port **8094** (loopback).
- **Files:** `index.js` (HTTP API), `db.js` (schema + queries), `memory.db` (gitignored).
- **Reached by:** the [`memory-bridge` MCP](mcp-bridges.md) (so Claude can search/add), the
  WhatsApp daemon's passive capture and `/memory` commands, and gmail/other features.

## Schema (`db.js`)

```
memories( id, type, content, summary, person, chat_id, topic, source,
          created_at, event_date, metadata )
  indexes: person, created_at, type, chat_id
memories_fts  -- FTS5 virtual table over (content, person, topic, summary),
              -- kept in sync by AFTER INSERT/DELETE/UPDATE triggers
```
`type` ∈ `conversation` | `note` | `fact` | `event` | `document` | `action` | `reminder`.
`source` ∈ `whatsapp` | `manual` | … . `metadata` is JSON text.

## Functions (`db.js`)

| Function | Signature | Role |
|---|---|---|
| `addMemory(obj)` | `({type,content,summary,person,chatId,topic,source,createdAt,eventDate,metadata}) → id` | Insert; FTS auto-syncs via trigger; returns `lastInsertRowid`. |
| `searchMemories(opts)` | `({query,person,dateFrom,dateTo,topic,type,limit=20}) → rows` | If `query`: FTS5 `MATCH` (quotes escaped) ordered by `rank`, **falling back to `likeSearch` on FTS syntax errors**; else `filterSearch`. |
| `likeSearch(opts)` | — | `content LIKE %q%` fallback. |
| `filterSearch(opts)` | — | No-query filter-only (person/date/topic/type). |
| `getRecentMemories(opts)` | `({limit=20,person,type,chatId}) → rows` | Most-recent first. |
| `getStats()` | `() → {total, byType[], bySource[], oldestEntry, dbSizeBytes}` | Introspection (size via `pragma_page_count*page_size`). |
| `deleteMemory(id)` | `(id) → result` | Delete (FTS trigger cleans the index). |

`index.js` helpers: `parseNaturalDate(expr)` turns "today"/"yesterday"/"last week"/"tuesday"/
"3 days ago"/ISO into a timestamp; `startOfDay/Week/Month`; `formatMemory(row)` shapes the API
response (adds `createdAtHuman` in `en-IN`, parses `metadata`).

## HTTP API (port 8094)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/add` | `{content, type?, summary?, person?, chatId?, topic?, source?, createdAt?, eventDate?, metadata?}` | `{ok, id}` |
| POST | `/bulk-add` | `{entries:[…]}` | `{ok, count, ids}` |
| POST | `/search` | `{query?, person?, dateFrom?, dateTo?, topic?, type?, limit?}` (dates accept natural language) | `{count, results[]}` |
| GET | `/recent` | `?limit=&person=&type=&chatId=` | `{count, results[]}` |
| GET | `/stats` | — | stats object |
| DELETE | `/delete/:id` | — | `{ok}` |

### Examples
```bash
# Add a fact
curl -s -X POST http://127.0.0.1:8094/add -H 'content-type: application/json' \
  -d '{"content":"Alex loves sushi","type":"fact","person":"Alex","topic":"food"}'

# Natural-language date search
curl -s -X POST http://127.0.0.1:8094/search -H 'content-type: application/json' \
  -d '{"query":"dinner","dateFrom":"last week"}'

# Stats
curl -s http://127.0.0.1:8094/stats
```
