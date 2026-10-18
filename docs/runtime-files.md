# Runtime & Config Files

Most files here are **gitignored** (secrets or machine-specific state) and created at runtime.
The one tracked exception among generated artifacts is `webui/dist/` (the built frontend, so
the server can pull-and-run). `devices.json` is also committed (registry, no secrets).

## Secrets / login state — NEVER commit
| Path | What |
|---|---|
| `*/.env`, `.env.*` | All module configs + API keys |
| `whatsapp-mcp/.wwebjs_auth/`, `.wwebjs_cache/` | WhatsApp Web session (your login!) |
| `whatsapp-mcp/qr.png` | Linking QR (regenerated each auth) |
| `gmail-monitor/tokens/`, `calendar-bridge/tokens/` | Google OAuth access+refresh tokens |
| `whatsapp-mcp/tts-service/voice-sample.wav` / `.txt` | Your reference voice for the twin |

## SQLite databases (gitignored)
| Path | Owner | Schema doc |
|---|---|---|
| `memory-store/memory.db` | memory-store | [memory-store.md](memory-store.md) |
| `price-tracker/prices.db` | price-tracker | [price-tracker.md](price-tracker.md) |
| `whatsapp-mcp/reminders.db` | reminders feature | [whatsapp-features.md](whatsapp-features.md) |

## WhatsApp daemon JSON state (gitignored)
| File | Shape |
|---|---|
| `claude-settings.json` | `{"model":"sonnet"}` — owner agent model |
| `claude-enabled.json` | `["<chatId>", …]` — chats where incoming `/claude` is allowed |
| `override-contacts.json` | `{"password":"…","contacts":["<chatId>", …]}` |
| `autoreply-data.json` | `{autoReplyEnabled, globalAutoReplies[], autoReplies[[chatId,{name,aiEnabled,rules[]}]]}` |
| `briefing-settings.json` | `{enabled, morningTime, eveningTime, chatId}` (IST `HH:MM`) |
| `twin-chats.json` | `{"<chatId>":{enabled, contactName, personaProfile, profileGeneratedAt, profileMessageCount, voiceEnabled}}` |
| `group-watch.json` | `{"<groupId>":"Group Name"}` |
| `user-profile.json` | Form-filler profile (name/email/phone/…) |
| `override-contacts.json` | (above) |

## Web UI state (gitignored unless noted)
| File | Shape |
|---|---|
| `webui/conversations/<id>.json` | `{id,title,model,workdir,createdAt,updatedAt,messages:[{role,text,ts}]}` |
| `webui/devices.json` | **committed** — `[{id,name,host,agentPort,kind,sshUser?,sshPort?}]` |
| `webui/projects.json` | `[{id,name,workdir,description,active,auto}]` |
| `webui/workflows.json` | `[{id,name,prompt,description,schedule:{type,…},createdAt,lastRun}]` |
| `webui/hub-config.json` | `{model,workdir,hiddenProjects[]}` (persists model/effort/workdir) |
| `webui/params.json` | `{systemPrompt,permissionMode,turnTimeoutSec}` |
| `webui/hub-tasks.json` | `[{id,sessionId,device,prompt,model,workdir,status,pid,startedAt,finishedAt}]` |
| `webui/usage-log.json` | `[{ts,model,in,out,cr}]` — per-turn token telemetry (feeds analytics) |

## Other
| File | Shape |
|---|---|
| `claude-tasks.json` (repo root) | `{tasks:{<id>:{id,description,status,createdAt,updatedAt,finishedAt?}}}` — written by `scripts/sync-claude-tasks.js`, read by the dashboard. Gitignored. |
| `gmail-monitor/classifier-feedback.json` | `{senderReputation:{email:score}, processedIds:[…]}` |
| `gmail-monitor/recent-emails.json` | `{shortId:{from,account,subject,ts}}` (24h window) |
| `logs/*.log`, `.pm2/` | PM2 stdout/stderr + process list (restored on reboot) |
