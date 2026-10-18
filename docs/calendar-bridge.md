# Calendar Bridge — `calendar-bridge/`

A **stdio MCP server** (not a PM2 daemon, and not an HTTP proxy bridge) that gives Claude
Google Calendar access across multiple authorized accounts. Claude spawns it on demand; it
loads OAuth tokens once at startup and talks to the Google Calendar API directly.

- **Deps:** `@modelcontextprotocol/sdk`, `googleapis`, `zod`.
- **Scopes:** `calendar`, `calendar.events`.
- **Files:** `index.js` (MCP tools), `oauth.js` (shared pattern with gmail-monitor),
  `setup.js` (`node calendar-bridge/setup.js add <email>` → browser OAuth → `tokens/`).
- **Env:** `CALENDAR_ACCOUNTS`, `TIMEZONE` (default `Asia/Kolkata`), `GOOGLE_CLIENT_ID/SECRET`.

## MCP tools (`index.js`)
| Tool | Params (zod) | Role |
|---|---|---|
| `calendar_list_accounts` | `{}` | List configured accounts + timezone. |
| `calendar_list_calendars` | `{account?}` | Calendars per account. |
| `calendar_get_events` | `{time_min, time_max, account?, calendar_id="primary", max_results=20}` | Events in a range. |
| `calendar_create_event` | `{account, summary, start, end, location?, description?, calendar_id="primary", attendees?, all_day?}` | Create an event. |
| `calendar_quick_add` | `{account, text, calendar_id="primary"}` | Natural-language create ("Team sync tomorrow 3pm for 1h"). |
| `calendar_update_event` | `{account, event_id, calendar_id="primary", summary?, start?, end?, location?, description?}` | Patch an event. |
| `calendar_delete_event` | `{account, event_id, calendar_id="primary"}` | Delete an event. |

Helpers: `getOAuthClient()`, `getAuthClientForAccount(email)` (auto-refresh), `fmtEvent(e,
account)` (response shape), `resolveClients(account?)` (one account or all). If an account's
token is invalid it's skipped silently. Driven from WhatsApp via `/cal …`
(see [whatsapp-daemon.md](whatsapp-daemon.md)) and used inside the morning/evening briefings.
