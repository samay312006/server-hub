// Gmail Monitor Daemon — Feature 2
// Polls configured Gmail accounts every N minutes, classifies emails for importance,
// and sends a WhatsApp digest for important ones. Adapts based on user feedback.
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from this directory
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const { config } = await import('dotenv');
  config({ path: envPath });
}

import { google } from 'googleapis';
import { getAuthClientForAccount } from './oauth.js';
import {
  classifyEmail, isProcessed, markProcessed,
  recordFeedback, saveRecentEmails, loadRecentEmails, normalizeSender,
} from './classifier.js';
import { tryAutoCreateEvent } from './calendar-sync.js';

// Decode Gmail API base64url body, handling multipart messages
function decodeGmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts) {
    // Prefer plain text; fall back to HTML stripped of tags
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64url').toString('utf8');
    const html = payload.parts.find(p => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return Buffer.from(html.body.data, 'base64url').toString('utf8')
        .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      const text = decodeGmailBody(part);
      if (text) return text;
    }
  }
  return '';
}

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES || '15', 10) * 60 * 1000;
const WA_CONTROL_URL = process.env.WA_CONTROL_URL || 'http://127.0.0.1:8091';
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '';
const MONITOR_PORT = parseInt(process.env.GMAIL_MONITOR_PORT || '8093', 10);

let accounts = (process.env.GMAIL_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
let isPaused = false;
const lastPollTime = {};

// ── WhatsApp sender ────────────────────────────────────────────────────────────
async function sendWhatsApp(message) {
  if (!OWNER_CHAT_ID) {
    console.error('[wa] OWNER_CHAT_ID not set in gmail-monitor/.env — skipping digest');
    return false;
  }
  try {
    const res = await fetch(`${WA_CONTROL_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: OWNER_CHAT_ID, message }),
    });
    return res.ok;
  } catch (e) {
    console.error('[wa] Send failed:', e.message);
    return false;
  }
}

// ── One-line email summarizer ──────────────────────────────────────────────────
async function summarizeEmail({ from, subject, snippet }) {
  const prompt = `Summarize this email in ONE concise sentence (max 15 words). Be specific about what action or info it contains.\nFrom: ${from}\nSubject: ${subject}\nPreview: ${snippet || '(no preview)'}`;

  if (process.env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: 60, messages: [{ role: 'user', content: prompt }] }),
      });
      const d = await res.json();
      const t = d.choices?.[0]?.message?.content?.trim();
      if (t) return t;
    } catch (_) {}
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const d = await res.json();
      const t = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (t) return t;
    } catch (_) {}
  }

  return snippet?.slice(0, 100) || '(no preview available)';
}

// ── Per-account poller ─────────────────────────────────────────────────────────
async function pollAccount(email) {
  let auth;
  try { auth = getAuthClientForAccount(email); }
  catch (e) { console.error(`[${email}] Token error: ${e.message}`); return []; }

  const gmail = google.gmail({ version: 'v1', auth });

  // On first run, look back 1 hour. On subsequent runs, since last poll.
  const afterSec = lastPollTime[email]
    ? Math.floor(lastPollTime[email] / 1000)
    : Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
  lastPollTime[email] = Date.now();

  let msgList;
  try {
    const r = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${afterSec}`,
      maxResults: 25,
    });
    msgList = r.data.messages || [];
  } catch (e) {
    console.error(`[${email}] List error: ${e.message}`);
    return [];
  }

  if (!msgList.length) return [];

  const important = [];
  for (const { id } of msgList) {
    if (isProcessed(id)) continue;
    markProcessed(id);

    let msg;
    try {
      const r = await gmail.users.messages.get({
        userId: 'me', id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      msg = r.data;
    } catch (e) {
      console.error(`[${email}] Get ${id} error: ${e.message}`);
      continue;
    }

    const hdrs = {};
    for (const h of msg.payload?.headers || []) hdrs[h.name] = h.value;

    const from = hdrs['From'] || '';
    const subject = hdrs['Subject'] || '(no subject)';
    const labels = msg.labelIds || [];
    const snippet = msg.snippet || '';
    const shortId = id.slice(-8);

    const { important: imp, reason } = classifyEmail({ from, subject, labels });
    console.log(`[${email}] ${imp ? '✅' : '⏭ '} [${reason.padEnd(20)}] ${subject.slice(0, 60)}`);

    if (!imp) continue;

    const summary = await summarizeEmail({ from, subject, snippet });
    // Auto-create calendar event for emails that mention a specific deadline
    const calEvent = await tryAutoCreateEvent({ account: email, from, subject, snippet }).catch(() => null);
    important.push({ id, shortId, account: email, from, subject, summary, calEvent });
  }

  return important;
}

// ── Main poll cycle ────────────────────────────────────────────────────────────
async function poll(manual = false) {
  if (isPaused) return;
  if (!accounts.length) {
    console.log('[poll] No accounts configured. Run: node setup.js add <email>');
    return;
  }
  console.log(`[poll] Starting — ${accounts.length} account(s) at ${new Date().toLocaleTimeString()}`);

  const allImportant = [];
  for (const email of accounts) {
    const results = await pollAccount(email);
    allImportant.push(...results);
  }

  if (!allImportant.length) {
    console.log('[poll] Done — no important emails.');
    if (manual) await sendWhatsApp(`✅ Checked ${accounts.length} inbox${accounts.length > 1 ? 'es' : ''} — no important emails.`);
    return;
  }

  // Persist recent emails for feedback lookup
  saveRecentEmails(allImportant);

  // Build WhatsApp digest
  const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  let msg = `📧 *Email Digest* — ${time}\n${allImportant.length} important email${allImportant.length > 1 ? 's' : ''}\n`;

  for (let i = 0; i < allImportant.length; i++) {
    const { shortId, account, from, subject, summary, calEvent } = allImportant[i];
    const senderName = from.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || normalizeSender(from);
    msg += `\n─────\n`;
    msg += `*${subject.slice(0, 70)}*\n`;
    msg += `👤 ${senderName}\n`;
    msg += `📝 ${summary}\n`;
    if (calEvent) {
      const timeStr = calEvent.time ? ` at ${calEvent.time}` : '';
      msg += `📅 Added to calendar: *${calEvent.title}* — ${calEvent.date}${timeStr}\n`;
    }
    msg += `📬 ${account} • #${shortId}\n`;
    msg += `/email-important ${shortId}  |  /email-spam ${shortId}`;
  }

  await sendWhatsApp(msg);
  console.log(`[poll] Digest sent — ${allImportant.length} email(s)`);
}

// ── HTTP Control API ───────────────────────────────────────────────────────────
// Called by whatsapp-mcp for feedback commands (/email-important, /email-spam, etc.)
http.createServer((req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    let p = {};
    try { p = body ? JSON.parse(body) : {}; } catch (_) { return sendJson(400, { error: 'bad json' }); }
    const url = new URL(req.url, `http://localhost:${MONITOR_PORT}`);

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(200, { paused: isPaused, accounts, lastPollTime });
    }

    // GET /recent-emails — returns shortId → { from, account, subject } map
    if (req.method === 'GET' && url.pathname === '/recent-emails') {
      return sendJson(200, loadRecentEmails());
    }

    // POST /feedback — { from, action: 'important'|'spam' }
    if (req.method === 'POST' && url.pathname === '/feedback') {
      if (!p.from || !p.action) return sendJson(400, { error: 'from and action required' });
      const score = recordFeedback(p.from, p.action);
      return sendJson(200, { ok: true, score });
    }

    // POST /poll-now — trigger an immediate manual poll (sends all-clear if nothing found)
    if (req.method === 'POST' && url.pathname === '/poll-now') {
      poll(true).catch(e => console.error('[poll] Error:', e.message));
      return sendJson(200, { ok: true, message: 'Poll started' });
    }

    // POST /pause
    if (req.method === 'POST' && url.pathname === '/pause') {
      isPaused = true;
      return sendJson(200, { ok: true, paused: true });
    }

    // POST /resume
    if (req.method === 'POST' && url.pathname === '/resume') {
      isPaused = false;
      return sendJson(200, { ok: true, paused: false });
    }

    // GET /accounts — list configured accounts
    if (req.method === 'GET' && url.pathname === '/accounts') {
      return sendJson(200, { accounts });
    }

    // POST /search — { account?, query, maxResults? }
    // Searches Gmail using any valid Gmail search query (same as the search box)
    if (req.method === 'POST' && url.pathname === '/search') {
      const { account, query, maxResults = 10 } = p;
      if (!query) return sendJson(400, { error: 'query required' });
      const targets = account ? [account] : accounts;
      if (!targets.length) return sendJson(400, { error: 'no accounts configured' });
      const results = [];
      for (const email of targets) {
        let auth;
        try { auth = getAuthClientForAccount(email); } catch (e) { continue; }
        const gmail = google.gmail({ version: 'v1', auth });
        try {
          const r = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
          for (const { id } of (r.data.messages || [])) {
            const m = await gmail.users.messages.get({
              userId: 'me', id, format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });
            const hdrs = {};
            for (const h of m.data.payload?.headers || []) hdrs[h.name] = h.value;
            results.push({
              id,
              shortId: id.slice(-8),
              account: email,
              from: hdrs['From'] || '',
              to: hdrs['To'] || '',
              subject: hdrs['Subject'] || '(no subject)',
              date: hdrs['Date'] || '',
              snippet: m.data.snippet || '',
              labels: m.data.labelIds || [],
            });
          }
        } catch (e) {
          console.error(`[search:${email}] ${e.message}`);
        }
      }
      return sendJson(200, { count: results.length, messages: results });
    }

    // POST /get-message — { account, id } — full email with decoded body
    if (req.method === 'POST' && url.pathname === '/get-message') {
      const { account, id } = p;
      if (!account || !id) return sendJson(400, { error: 'account and id required' });
      let auth;
      try { auth = getAuthClientForAccount(account); }
      catch (e) { return sendJson(400, { error: e.message }); }
      const gmail = google.gmail({ version: 'v1', auth });
      try {
        const r = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const msg = r.data;
        const hdrs = {};
        for (const h of msg.payload?.headers || []) hdrs[h.name] = h.value;
        const body = decodeGmailBody(msg.payload);
        return sendJson(200, {
          id: msg.id,
          account,
          from: hdrs['From'] || '',
          to: hdrs['To'] || '',
          subject: hdrs['Subject'] || '(no subject)',
          date: hdrs['Date'] || '',
          snippet: msg.snippet || '',
          body: body.slice(0, 8000), // cap at 8KB to keep responses manageable
          labels: msg.labelIds || [],
        });
      } catch (e) {
        return sendJson(500, { error: e.message });
      }
    }

    return sendJson(404, { error: 'not found' });
  });
}).listen(MONITOR_PORT, '127.0.0.1', () => {
  console.log(`📬 Gmail monitor API on http://127.0.0.1:${MONITOR_PORT}`);
});

// ── Start ──────────────────────────────────────────────────────────────────────
if (!accounts.length) {
  console.log('⚠️  No Gmail accounts configured.');
  console.log('   1. Set GMAIL_ACCOUNTS in gmail-monitor/.env');
  console.log('   2. Run: node setup.js add <your@gmail.com>');
} else {
  console.log(`📬 Gmail Monitor — watching: ${accounts.join(', ')}`);
  console.log(`⏱  Polling every ${POLL_INTERVAL_MS / 60000} min | Control API :${MONITOR_PORT}`);
  setTimeout(poll, 20 * 1000);         // first poll after 20s startup delay
  setInterval(poll, POLL_INTERVAL_MS); // recurring poll
}
