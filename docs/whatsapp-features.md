# WhatsApp Features, Digital Twin & TTS

The daemon's command handlers (in `whatsapp-mcp/index.js`, see
[whatsapp-daemon.md](whatsapp-daemon.md)) delegate the heavy lifting to small modules under
`whatsapp-mcp/features/`. Most modules are **prompt builders**: they return a string that the
daemon hands to `spawnClaude()`, so the real work (browsing, OCR, memory writes) is done by
the agent with the right MCP tools. A few hold their own SQLite state (reminders).

---

## `features/form-filler.js` — autonomous form filling
| Function | Signature | Role |
|---|---|---|
| `loadProfile()` | `() → object` | Load `user-profile.json` (your name/email/phone/etc.), stripping `_note`. |
| `classifyFormImportance(url)` | `(url) → 'important'\|'simple'` | Regex-match the URL for sensitive contexts (college, bank, passport, NEET…). |
| `extractUrl(text)` | `(text) → string\|null` | First `https?://` URL in the command. |
| `buildFillPrompt(opts)` | `(opts) → string` | Build the Claude prompt: navigate, snapshot, fill from profile. **Important** forms → screenshot + owner review before submit; **simple** forms → submit directly. |

Flow: `/fill <url>` → `handleFillCommand` classifies → for important forms the agent fills,
screenshots, and waits; you `/fill-confirm` to submit or `/fill-cancel` to abort.

## `features/memory-watcher.js` — passive capture
| Function | Signature | Role |
|---|---|---|
| `captureMessage(msg, contactResolver)` | `(msg, resolver) → Promise<void>` | Fire-and-forget POST of every conversational message to memory-store `/add` (`type:"conversation"`). Skips commands, empties, and <2-char messages via `SKIP_PATTERNS`. |

This is what makes `/memory "what did X say about Y"` work later — ordinary chat is silently
indexed (see [memory-store.md](memory-store.md)).

## `features/research-agent.js`
| Function | Signature | Role |
|---|---|---|
| `buildResearchPrompt(query, chatId)` | `(query, chatId) → string` | Prompt: search DuckDuckGo, visit the top 2–3 results, extract facts, save them to memory as `type:"fact"`, and send a <900-char WhatsApp summary. |

## `features/doc-pipeline.js` — document intelligence
| Function | Signature | Role |
|---|---|---|
| `extractPdfText(filePath)` | `(fp) → Promise<string>` | `pdf-parse` text extraction; `""` if the PDF is scanned. |
| `buildDocOcrPrompt(fp, title, chatId, mime)` | → string | For scanned PDFs/images: have Claude read the file with vision, extract text, save to memory (`type:"document"`), confirm. |
| `buildDocSavePrompt(text, title, chatId, mime, fp)` | → string | Text already extracted → save to memory + confirm. |
| `buildDocSearchPrompt(query, chatId)` | → string | Search `type:"document"` memory entries. |
| `buildDocListPrompt(chatId)` | → string | List indexed documents. |
| `buildDocNotionPrompt(titleQuery, chatId)` | → string | Find a document and push it to Notion. |

`handleDocCommand` saves the attachment to a temp file (auto-cleaned after ~15 min) and picks
the right prompt by MIME type (PDF text vs vision, images vs `.docx`/`.txt`/`.csv`).

## `features/group-intelligence.js`
| Function | Signature | Role |
|---|---|---|
| `mightBeActionItem(text)` | `(text) → boolean` | Cheap regex pre-filter (todo / can you / deadline / @mention…). |
| `extractActionItem(text, group, sender, groqKey)` | → `{isAction,assignee,action,deadline,summary}\|null` | Groq call to structure an action item from a message. |
| `buildGroupSummaryPrompt(group, chatId, hours)` | → string | Summarize the group's last N hours from memory. |
| `buildGroupActionsPrompt(group, chatId)` | → string | List pending action items as a checklist. |
| `watchGroupMessages(msg)` | → Promise | On each message in a watched group: pre-filter → extract → save `type:"action"` to memory. |

State: `watchedGroups` (chatId → name), persisted to `group-watch.json`.

## `features/reminders.js` — its own SQLite (`reminders.db`)
| Function | Signature | Role |
|---|---|---|
| `addReminder({chatId,message,fireAt,repeatMs})` | → id | Insert a reminder row. |
| `listReminders(chatId)` / `listAllReminders()` | → rows | Active reminders for a chat / everywhere. |
| `getDueReminders()` | → rows | `fireAt <= now`. |
| `advanceOrComplete(id, repeatMs)` | → void | Reschedule (repeating) or deactivate (one-shot). |
| `cancelReminder(id)` | → bool | Soft-cancel. |
| `parseReminderNL(text, groqKey)` | → `{message,fireAt,repeatMs}\|null` | Groq parses "call mom in 2 hours" / "every day at 9" into an ISO `fireAt` + repeat interval. |
| `formatFireAt` / `formatRepeat` | → string | Human-friendly "in 2h 5m (Tue, …)" / "daily". |

A 60 s poller (`startReminderPoller`) sends due reminders and advances repeats; it also fires
anything missed while the daemon was down (5 s after startup).

## `features/briefing.js` — morning/evening digests
| Function | Signature | Role |
|---|---|---|
| `loadBriefingSettings()` / `saveBriefingSettings(s)` | | Read/write `briefing-settings.json`. |
| `buildMorningBriefingPrompt(chatId)` | → string | Pull today's calendar, fresh Gmail, today's reminders, price alerts, group actions → a ~1200-char card. |
| `buildEveningBriefingPrompt(chatId)` | → string | Tomorrow's calendar, important unread, next-18h reminders, prices, day summary. |
| `currentISTTime()` | → `{hh,mm,key}` | Asia/Kolkata clock. |
| `parseHHMM(str)` | → string\|null | Validate "HH:MM". |

A 60 s scheduler (`startBriefingScheduler`) fires each briefing once/day when the IST clock
matches `morningTime`/`eveningTime` (deduped via `firedBriefings`).

---

## Digital Twin — persona auto-reply (in `index.js`)

The twin answers **on your behalf** in selected chats, mimicking your style from chat history,
and routing each incoming message to the cheapest model that can handle it.

### Functions
| Function | ~line | Role |
|---|---|---|
| `generatePersonaProfile(chatId, name, ownerMsgs, liveMsgs)` | 212 | Pull ~500 messages from the chat; ask Gemini (Groq fallback) to write a 300–400-word behavioral profile (relationship + speaking style). |
| `regexClassify(text)` | 282 | Fast path: detect pure acks / emoji / one-word replies → `'simple'`. |
| `classifyMessage(text)` | 289 | Else ask Groq to tier the message `simple\|medium\|complex` (biases **up** on ambiguity). |
| `buildTwinSystemPrompt(twin, name)` | 1173 | Persona + strict rules: raw text only, no XML, natural emoji, **deny credential/OTP requests**, never reveal it's an AI. |
| `buildTwinUserContent(name, ctx, body)` | 1190 | Format the incoming message with a recent-context window. |
| `sanitiseTwinReply(reply)` | 1198 | Strip stray XML tags / role labels from model output. |
| `getTwinReplySimple/Medium/Complex` | 1231/1236/1263 | Simple→Medium = Gemini Flash 2.0; Complex = `spawnClaudeText(..., 'claude-sonnet-4-6')`. |
| `fetchLiveChatContext(chat, name, limit=8)` | 1140 | Recent messages as context, filtering out bot-noise. |
| `getTwinVoiceNote(text)` | 1208 | POST to the TTS service (`:5050/synthesize`); returns an OGG path or null. |
| `handleDigitalTwin(msg)` | 2525 | Entry point: buffer the incoming burst, then schedule `fireTwinReply`. |
| `fireTwinReply(chatId, twin)` | 2471 | Combine the burst, classify the tier, fetch context, call the tier's reply fn, send text **or** a voice note. |

### Flow
```
Contact ─► "hey you free tonight?"  ... "wanna catch a movie?"   (two quick messages)
  handleDigitalTwin buffers them for TWIN_BURST_MS (3.5 s) in twinBurst
  fireTwinReply:
    classifyMessage → 'medium'
    fetchLiveChatContext → recent thread
    getTwinReplyMedium (Gemini, persona prompt) → "yeah I'm free! what're we watching 😄"
    voiceEnabled? → getTwinVoiceNote → send OGG ; else send text
```

Tiers degrade gracefully (complex → medium → simple) on rate limits. State per chat lives in
`twin-chats.json` (`enabled`, `contactName`, `personaProfile`, `profileGeneratedAt`,
`profileMessageCount`, `voiceEnabled`). Constants: `TWIN_BURST_MS=3500`,
`TWIN_GENERIC_PROFILE`, `TWIN_SENSITIVE_DENIAL`, `TTS_URL="http://127.0.0.1:5050"`.

---

## TTS service — `tts-service/tts_server.py` (F5-TTS, port 5050)

A small Python HTTP server that clones **your** voice for twin voice notes.

| Endpoint / fn | Role |
|---|---|
| `load_model()` | Load F5-TTS on first use (CPU or CUDA) on a background thread. |
| `GET /health` | `{model loaded?, voice sample present?}`. |
| `POST /synthesize` | `{text}` → generate WAV from the reference voice, transcode to OGG/opus (≈32 kbps) via ffmpeg, return `audio/ogg`. |

Requires a reference clip `voice-sample.wav` (and optionally `voice-sample.txt` transcript to
skip first-run auto-transcription via faster-whisper). Both are gitignored. The service is
optional — without it, `/twin-voice-on` falls back to text.
