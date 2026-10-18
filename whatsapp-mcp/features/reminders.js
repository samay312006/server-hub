// Feature 10: Smart Reminder & Natural Language Scheduler
// SQLite-backed reminder store. Parses natural language via Groq.
// The daemon polls every 60 s and fires due reminders via WhatsApp.

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'reminders.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId    TEXT    NOT NULL,
    message   TEXT    NOT NULL,
    fireAt    INTEGER NOT NULL,
    repeatMs  INTEGER,               -- null = one-shot; N = repeat every N ms
    fired     INTEGER DEFAULT 0,
    active    INTEGER DEFAULT 1,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(active, fireAt);
`);

export function addReminder({ chatId, message, fireAt, repeatMs = null }) {
  return db.prepare(
    'INSERT INTO reminders (chatId, message, fireAt, repeatMs, createdAt) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, message, fireAt, repeatMs ?? null, Date.now()).lastInsertRowid;
}

export function listReminders(chatId) {
  return db.prepare(
    'SELECT * FROM reminders WHERE active=1 AND chatId=? ORDER BY fireAt ASC'
  ).all(chatId);
}

export function listAllReminders() {
  return db.prepare('SELECT * FROM reminders WHERE active=1 ORDER BY fireAt ASC').all();
}

export function getDueReminders() {
  return db.prepare('SELECT * FROM reminders WHERE active=1 AND fireAt <= ?').all(Date.now());
}

export function advanceOrComplete(id, repeatMs) {
  if (repeatMs) {
    // Reschedule to next occurrence
    db.prepare('UPDATE reminders SET fired=fired+1, fireAt=fireAt+? WHERE id=?').run(repeatMs, id);
  } else {
    db.prepare('UPDATE reminders SET fired=fired+1, active=0 WHERE id=?').run(id);
  }
}

export function cancelReminder(id) {
  return db.prepare('UPDATE reminders SET active=0 WHERE id=?').run(id).changes > 0;
}

// ── Natural language parser via Groq ──────────────────────────────────────────
const TZ = 'Asia/Kolkata';

export async function parseReminderNL(text, groqKey) {
  if (!groqKey) return null;

  const nowIST = new Date().toLocaleString('en-IN', { timeZone: TZ,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false });
  const nowMs = Date.now();

  const prompt =
    `Parse this reminder request. Return ONLY valid JSON — no markdown.\n` +
    `{"message":"clean reminder text","fireAt":"ISO 8601 with +05:30 offset","repeatMs":null}\n\n` +
    `Current time (IST): ${nowIST}\n` +
    `Request: "${text}"\n\n` +
    `Rules:\n` +
    `- message: strip "remind me to", "reminder", "remind" prefix; keep action concise\n` +
    `- fireAt: exact ISO 8601 datetime in IST (+05:30). Calculate from current time for relative phrases.\n` +
    `  "in 2 hours" = now+2h | "tomorrow at 9am" = next day 09:00 IST | "tonight at 10" = today 22:00 IST\n` +
    `  "next Monday at 6pm" = coming Monday 18:00 IST | If no time given assume in 1 hour.\n` +
    `- repeatMs: null for one-shot. For recurring:\n` +
    `  "every hour"=3600000 | "every day/daily"=86400000 | "every week/weekly"=604800000\n` +
    `  "every Monday/Wednesday/..." = 604800000 (weekly)\n` +
    `  "twice a day" = 43200000 (12h)\n` +
    `- Never guess — if time is truly ambiguous, set fireAt to 1 hour from now.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 150,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!parsed.message || !parsed.fireAt) return null;

    const fireAtMs = new Date(parsed.fireAt).getTime();
    if (isNaN(fireAtMs) || fireAtMs < nowMs) return null;

    return {
      message: parsed.message.trim(),
      fireAt: fireAtMs,
      repeatMs: parsed.repeatMs ? parseInt(parsed.repeatMs, 10) : null,
    };
  } catch (e) {
    console.error('[reminders] Groq parse failed:', e.message);
    return null;
  }
}

// ── Format helpers ─────────────────────────────────────────────────────────────
export function formatFireAt(fireAtMs) {
  const diff = fireAtMs - Date.now();
  const absMin = Math.round(Math.abs(diff) / 60000);
  const dateStr = new Date(fireAtMs).toLocaleString('en-IN', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  if (diff > 0 && diff < 60 * 60 * 1000) return `in ${absMin} min  (${dateStr})`;
  if (diff > 0 && diff < 24 * 60 * 60 * 1000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.round((diff % 3600000) / 60000);
    return `in ${h}h ${m > 0 ? m + 'm' : ''}  (${dateStr})`.trim();
  }
  return dateStr;
}

export function formatRepeat(repeatMs) {
  if (!repeatMs) return null;
  if (repeatMs === 3600000) return 'every hour';
  if (repeatMs === 43200000) return 'twice daily';
  if (repeatMs === 86400000) return 'daily';
  if (repeatMs === 604800000) return 'weekly';
  const h = Math.round(repeatMs / 3600000);
  return h >= 24 ? `every ${Math.round(h / 24)}d` : `every ${h}h`;
}
