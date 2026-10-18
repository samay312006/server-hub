// calendar-sync: called by gmail-monitor after classifying an important email.
// If the email mentions a specific deadline date, extracts it via Groq and
// auto-creates a Google Calendar event on the recipient's primary calendar.
import { google } from 'googleapis';
import { getAuthClientForAccount } from '../calendar-bridge/oauth.js';

const TZ = 'Asia/Kolkata';

// Trigger only on emails that clearly mention a deadline/event
const DEADLINE_RE = /\b(deadline|due date|due on|submit|submission|assignment|exam|test|quiz|viva|lab|project|last date|expir|register|enroll|apply by|scheduled for|session on|class on|workshop)\b/i;

function getCalendarClient(email) {
  try {
    const auth = getAuthClientForAccount(email);
    return google.calendar({ version: 'v3', auth });
  } catch (_) {
    return null; // no calendar token for this account — skip silently
  }
}

async function extractDeadline(from, subject, snippet) {
  if (!process.env.GROQ_API_KEY) return null;
  const today = new Date().toLocaleDateString('en-IN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [d, m, y] = today.split('/');
  const todayISO = `${y}-${m}-${d}`;

  const prompt =
    `Extract any deadline or event date from this email. Return ONLY valid JSON — no markdown, no explanation.\n` +
    `{"hasDeadline": boolean, "title": "short action title max 6 words", "date": "YYYY-MM-DD or null", "time": "HH:MM 24h or null"}\n\n` +
    `Today: ${todayISO} (IST). Year is ${y} unless stated otherwise.\n` +
    `From: ${from}\nSubject: ${subject}\nPreview: ${snippet}\n\n` +
    `Rules:\n` +
    `- hasDeadline=true ONLY if a specific date is explicitly mentioned\n` +
    `- title: action-focused, e.g. "Lab Report Submission", "Mid Sem Exam", "Assignment 2 Due"\n` +
    `- date: null if vague ("next week", "soon") — must be a real parseable date\n` +
    `- time: 24h format if a specific time is mentioned, otherwise null`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 120,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed;
  } catch (e) {
    console.error('[calendar-sync] Groq extraction failed:', e.message);
    return null;
  }
}

// Returns { title, date, time, link } if an event was created, otherwise null.
export async function tryAutoCreateEvent({ account, from, subject, snippet }) {
  // Quick keyword check before making any API calls
  if (!DEADLINE_RE.test(subject) && !DEADLINE_RE.test(snippet)) return null;

  const cal = getCalendarClient(account);
  if (!cal) return null;

  const info = await extractDeadline(from, subject, snippet);
  if (!info?.hasDeadline || !info?.date) return null;

  const { title, date, time } = info;
  if (!title || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  // Sanity: reject dates in the far past (>30 days ago)
  if (new Date(date) < new Date(Date.now() - 30 * 86400000)) return null;

  try {
    let resource;
    if (time && /^\d{2}:\d{2}$/.test(time)) {
      const [h, min] = time.split(':').map(Number);
      const endH = Math.min(h + 1, 23);
      resource = {
        summary: title,
        description: `📧 Auto-created from email\nFrom: ${from}\nSubject: ${subject}`,
        start: { dateTime: `${date}T${time}:00`, timeZone: TZ },
        end: { dateTime: `${date}T${String(endH).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`, timeZone: TZ },
        colorId: '11', // tomato red
      };
    } else {
      // All-day deadline marker
      const nextDay = new Date(date);
      nextDay.setDate(nextDay.getDate() + 1);
      const endDate = nextDay.toISOString().slice(0, 10);
      resource = {
        summary: title,
        description: `📧 Auto-created from email\nFrom: ${from}\nSubject: ${subject}`,
        start: { date },
        end: { date: endDate },
        colorId: '11',
      };
    }

    const res = await cal.events.insert({ calendarId: 'primary', resource });
    console.log(`[calendar-sync] ✅ Created: "${title}" on ${date} for ${account}`);
    return { title, date, time: time || null, link: res.data.htmlLink };
  } catch (e) {
    console.error(`[calendar-sync] Event creation failed: ${e.message}`);
    return null;
  }
}
