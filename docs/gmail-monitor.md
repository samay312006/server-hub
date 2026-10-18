# Gmail Monitor — `gmail-monitor/`

Polls one or more Gmail inboxes, classifies each new mail for **personal importance**, and
sends a WhatsApp digest of the important ones. It learns from your `/email-important` /
`/email-spam` feedback, and can auto-create calendar events from deadline emails.

- **Process:** PM2 `gmail-monitor`, `max_memory_restart: 150M`, port **8093** (loopback).
- **Deps:** `googleapis`, `dotenv`. **OAuth scope:** `gmail.readonly`.
- **Files:** `index.js`, `classifier.js`, `oauth.js`, `calendar-sync.js`, `setup.js`.
- **Setup:** `node gmail-monitor/setup.js add <email>` opens a browser OAuth flow (callback on
  `localhost:4321`), storing tokens under `gmail-monitor/tokens/` (gitignored).
- **Reached by:** the [`gmail-bridge` MCP](mcp-bridges.md) and the WhatsApp `/email-*` commands.

## `index.js`
| Function | ~line | Role |
|---|---|---|
| `decodeGmailBody(payload)` | 27 | Extract text from a multipart MIME tree (prefers plain text). |
| `sendWhatsApp(message)` | 60 | POST to the WhatsApp daemon `/send` (uses `OWNER_CHAT_ID`). |
| `summarizeEmail({from,subject,snippet})` | 79 | One-line summary via Groq or Gemini (optional). |
| `pollAccount(email)` | 112 | Query an inbox, classify each new message, summarize, try calendar auto-create; returns important ones. |
| `poll(manual?)` | 182 | Poll all accounts, build the digest, send it. Runs on the `POLL_INTERVAL_MINUTES` timer. |

## `classifier.js` — the importance heuristic
| Function | Role |
|---|---|
| `normalizeSender(from)` | `"Name <email>"` → lowercased `email`. |
| `recordFeedback(from, action)` | ±1 to the sender's reputation; persisted to `classifier-feedback.json`. |
| `isProcessed` / `markProcessed(id)` | De-dupe seen messages (rolling 5000-id window). |
| `saveRecentEmails` / `loadRecentEmails` | Maintain the last-24h `shortId → {from,subject,…}` map used by `gmail_mark_feedback`. |
| `classifyEmail({from,subject,labels})` | `{important, reason}` |

`classifyEmail` order: (1) hard-skip `CATEGORY_PROMOTIONS/SOCIAL/UPDATES/FORUMS/SPAM` and
no-reply/newsletter sender patterns; (2) **learned feedback overrides** (reputation ≤ −2 =
spam, ≥ +2 = important); (3) institutional domains (VIT etc.) are *not* auto-approved — only
flagged if the subject hits a personal-relevance keyword (attendance, fee, placement,
deadline…); (4) env `SENDER_WHITELIST`; (5) subject vs `IMPORTANT_KEYWORDS` (built-in default
list). Each decision returns a `reason` string for debuggability.

## `oauth.js`
`getOAuthClient()`, `getAuthClientForAccount(email)` (loads tokens, auto-refreshes on the
`tokens` event), `authorizeAccount(email)` (browser flow on `:4321`). Shared pattern with
`calendar-bridge/oauth.js`.

## `calendar-sync.js`
`tryAutoCreateEvent({account,from,subject,snippet})` — ask Groq to extract a deadline; if
found, create a Google Calendar event (needs `calendar-bridge` tokens for that account).

## HTTP API (port 8093)
| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | `{paused, accounts[], lastPollTime}` |
| GET | `/accounts` | monitored inboxes |
| GET | `/recent-emails` | last-24h `shortId` map (feedback lookup) |
| POST | `/feedback` | `{from, action:"important"\|"spam"}` → train classifier |
| POST | `/poll-now` / `/pause` / `/resume` | control polling |
| POST | `/search` | `{account?, query, maxResults?}` Gmail-syntax search |
| POST | `/get-message` | `{account, id}` → full email |

### Example
```bash
curl -s http://127.0.0.1:8093/status
curl -s -X POST http://127.0.0.1:8093/search -H 'content-type: application/json' \
  -d '{"query":"subject:exam after:2026/06/01"}'
```
