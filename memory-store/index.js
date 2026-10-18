// Memory Store Daemon — Feature 3
// Owns the SQLite database. Accepts writes from whatsapp-mcp (auto-capture),
// gmail-monitor, and manual /memory commands. Serves searches to the MCP bridge.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load PORT from .env manually — no dotenv dependency needed
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import { addMemory, searchMemories, getRecentMemories, getStats, deleteMemory } from './db.js';

const PORT = parseInt(process.env.MEMORY_STORE_PORT || '8094', 10);

// ── Helpers ────────────────────────────────────────────────────────────────────

// Parse natural language date expressions into timestamps
// Handles: "tuesday", "yesterday", "last week", "3 days ago", "june 5", ISO dates
function parseNaturalDate(expr) {
  if (!expr) return null;
  const now = new Date();
  const lower = expr.toLowerCase().trim();

  if (lower === 'today') return startOfDay(now).getTime();
  if (lower === 'yesterday') return startOfDay(new Date(now - 86400000)).getTime();
  if (lower === 'last week') return new Date(now - 7 * 86400000).getTime();
  if (lower === 'this week') return startOfWeek(now).getTime();
  if (lower === 'this month') return startOfMonth(now).getTime();

  const daysAgo = lower.match(/^(\d+)\s+days?\s+ago$/);
  if (daysAgo) return new Date(now - parseInt(daysAgo[1]) * 86400000).getTime();

  const weeksAgo = lower.match(/^(\d+)\s+weeks?\s+ago$/);
  if (weeksAgo) return new Date(now - parseInt(weeksAgo[1]) * 7 * 86400000).getTime();

  // Day names: "monday", "tuesday", etc.
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayIdx = days.indexOf(lower);
  if (dayIdx >= 0) {
    const d = new Date(now);
    const diff = (d.getDay() - dayIdx + 7) % 7 || 7; // last occurrence
    d.setDate(d.getDate() - diff);
    return startOfDay(d).getTime();
  }

  // Try native date parse as fallback
  const parsed = new Date(expr);
  return isNaN(parsed) ? null : parsed.getTime();
}

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function startOfWeek(d) { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0,0,0,0); return x; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function formatMemory(m) {
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    summary: m.summary,
    person: m.person,
    chatId: m.chat_id,
    topic: m.topic,
    source: m.source,
    createdAt: m.created_at,
    createdAtHuman: new Date(m.created_at).toLocaleString('en-IN'),
    eventDate: m.event_date,
    metadata: m.metadata ? (() => { try { return JSON.parse(m.metadata); } catch { return m.metadata; } })() : null,
  };
}

// ── HTTP API ───────────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  let body = '';
  req.on('data', c => { body += c; if (body.length > 5e5) req.destroy(); });
  req.on('end', () => {
    let p = {};
    try { p = body ? JSON.parse(body) : {}; } catch (_) { return sendJson(400, { error: 'bad json' }); }
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // POST /add — add a memory entry
    if (req.method === 'POST' && url.pathname === '/add') {
      if (!p.content) return sendJson(400, { error: 'content required' });
      try {
        const id = addMemory(p);
        return sendJson(200, { ok: true, id });
      } catch (e) { return sendJson(500, { error: e.message }); }
    }

    // POST /bulk-add — add multiple entries (WhatsApp conversation batches)
    if (req.method === 'POST' && url.pathname === '/bulk-add') {
      if (!Array.isArray(p.entries)) return sendJson(400, { error: 'entries array required' });
      try {
        const ids = p.entries.map(e => addMemory(e));
        return sendJson(200, { ok: true, count: ids.length, ids });
      } catch (e) { return sendJson(500, { error: e.message }); }
    }

    // POST /search — search memories
    if (req.method === 'POST' && url.pathname === '/search') {
      try {
        const dateFrom = p.dateFrom ? parseNaturalDate(p.dateFrom) : null;
        const dateTo = p.dateTo ? (parseNaturalDate(p.dateTo) + 86400000) : null; // end of day
        const results = searchMemories({ ...p, dateFrom, dateTo });
        return sendJson(200, { count: results.length, results: results.map(formatMemory) });
      } catch (e) { return sendJson(500, { error: e.message }); }
    }

    // GET /recent — recent memories
    if (req.method === 'GET' && url.pathname === '/recent') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const person = url.searchParams.get('person') || undefined;
        const type = url.searchParams.get('type') || undefined;
        const chatId = url.searchParams.get('chatId') || undefined;
        const results = getRecentMemories({ limit, person, type, chatId });
        return sendJson(200, { count: results.length, results: results.map(formatMemory) });
      } catch (e) { return sendJson(500, { error: e.message }); }
    }

    // GET /stats
    if (req.method === 'GET' && url.pathname === '/stats') {
      try { return sendJson(200, getStats()); }
      catch (e) { return sendJson(500, { error: e.message }); }
    }

    // DELETE /delete/:id
    if (req.method === 'DELETE' && url.pathname.startsWith('/delete/')) {
      const id = parseInt(url.pathname.split('/')[2], 10);
      if (!id) return sendJson(400, { error: 'invalid id' });
      try {
        deleteMemory(id);
        return sendJson(200, { ok: true });
      } catch (e) { return sendJson(500, { error: e.message }); }
    }

    return sendJson(404, { error: 'not found' });
  });
}).listen(PORT, '127.0.0.1', () => {
  const stats = getStats();
  console.log(`🧠 Memory Store running on http://127.0.0.1:${PORT}`);
  console.log(`📊 ${stats.total} memories stored | DB: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`);
});
