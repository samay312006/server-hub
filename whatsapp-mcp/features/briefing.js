// Feature 11: Morning & Evening Briefing Bot
// Builds Claude prompts that aggregate calendar, email, reminders, prices, groups.
// Settings (enabled, morningTime, eveningTime) persisted to briefing-settings.json.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(__dirname, '..', 'briefing-settings.json');

const DEFAULT_SETTINGS = {
  enabled: true,
  morningTime: '07:30',   // HH:MM IST
  eveningTime: '21:00',
  chatId: null,           // set on first scheduled fire (owner's Saved Messages)
};

export function loadBriefingSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

export function saveBriefingSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Prompt builders ──────────────────────────────────────────────────────────

const TZ = 'Asia/Kolkata';

function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: TZ, weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export function buildMorningBriefingPrompt(chatId) {
  const dateStr = nowIST();
  return (
    `Generate my *morning briefing* for ${dateStr} (IST) and send it to WhatsApp chat "${chatId}".\n\n` +
    `Pull data in this exact order using your tools:\n\n` +
    `1. **Google Calendar** — use google_calendar_list_events for today (full day). Summarise all events with their times.\n\n` +
    `2. **Gmail** — use gmail_search_emails with query "is:unread newer_than:1d" to find new emails since yesterday. Pick the 3 most important (sender + subject line only, no body). Skip newsletters/automated emails.\n\n` +
    `3. **Active Reminders today** — use memory_search with type="reminder" OR read from any reminder data you can access. List reminders firing today.\n\n` +
    `4. **Price Alerts** — use the HTTP tool to call GET http://127.0.0.1:8095/products to fetch tracked products and their current prices. List any that hit target or dropped >10% in the last 24h. Skip if the endpoint is down.\n\n` +
    `5. **Group highlights** — use memory_search with type="group_action" and query="action items" to find any unresolved group action items from the last 24h.\n\n` +
    `Now compose and send ONE WhatsApp message to chat "${chatId}" with this format:\n\n` +
    `☀️ *Good Morning! — [Day, Date]*\n\n` +
    `📅 *Today's Schedule*\n` +
    `[bullet list of events, or "Nothing scheduled"]\n\n` +
    `📧 *Inbox Highlights*\n` +
    `[3 most important emails, or "No new emails"]\n\n` +
    `⏰ *Reminders Today*\n` +
    `[list, or "None set for today"]\n\n` +
    `💰 *Price Alerts*\n` +
    `[alerts, or "No alerts"]\n\n` +
    `📋 *Action Items*\n` +
    `[group action items, or "None"]\n\n` +
    `Keep the entire message under 1200 characters. ` +
    `If a section has no data, keep it brief ("None" or "Nothing scheduled"). ` +
    `Do NOT add commentary or explanations outside the briefing card. ` +
    `After sending, output only: ✅`
  );
}

export function buildEveningBriefingPrompt(chatId) {
  const dateStr = nowIST();
  return (
    `Generate my *evening briefing* for ${dateStr} (IST) and send it to WhatsApp chat "${chatId}".\n\n` +
    `Pull data in this exact order using your tools:\n\n` +
    `1. **Tomorrow's Calendar** — use google_calendar_list_events for tomorrow. List all events with times.\n\n` +
    `2. **Unanswered emails** — use gmail_search_emails with query "is:unread is:important" to find important unread emails. Show subject + sender for up to 3.\n\n` +
    `3. **Upcoming Reminders** — use memory_search with type="reminder" OR any reminder store to find reminders firing in the next 18h.\n\n` +
    `4. **Price Tracker summary** — use GET http://127.0.0.1:8095/products to list all actively tracked products with their current vs target price. Skip if the endpoint is down.\n\n` +
    `5. **Day summary** — use memory_search with source="whatsapp" and query="today" (broad) to find any important conversations or decisions from today worth noting.\n\n` +
    `Compose and send ONE WhatsApp message to chat "${chatId}":\n\n` +
    `🌙 *Evening Wrap-up — [Day, Date]*\n\n` +
    `📅 *Tomorrow's Schedule*\n` +
    `[bullet list, or "Nothing scheduled"]\n\n` +
    `📧 *Needs Your Attention*\n` +
    `[important unread emails, or "Inbox clear"]\n\n` +
    `⏰ *Coming Up*\n` +
    `[reminders in next 18h, or "Nothing"]\n\n` +
    `💰 *Price Watch*\n` +
    `[tracked products status, or "None tracked"]\n\n` +
    `📝 *Today's Highlights*\n` +
    `[1-2 line summary of today, or "Quiet day"]\n\n` +
    `Keep the entire message under 1200 characters. ` +
    `Do NOT add commentary or explanations outside the briefing card. ` +
    `After sending, output only: ✅`
  );
}

// ── Time helpers ──────────────────────────────────────────────────────────────

export function currentISTTime() {
  const now = new Date();
  const [hh, mm] = now.toLocaleTimeString('en-IN', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).split(':').map(Number);
  return { hh, mm, key: `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}` };
}

export function parseHHMM(str) {
  const m = (str || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}
