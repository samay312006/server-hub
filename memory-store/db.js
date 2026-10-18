// Memory database — SQLite with FTS5 for full-text search.
// Uses Node.js built-in node:sqlite (Node 22.5+), no npm deps needed.
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'memory.db');

const db = new DatabaseSync(DB_PATH);

// ── Schema ─────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT    NOT NULL DEFAULT 'conversation',
    content     TEXT    NOT NULL,
    summary     TEXT,
    person      TEXT,
    chat_id     TEXT,
    topic       TEXT,
    source      TEXT    DEFAULT 'manual',
    created_at  INTEGER NOT NULL,
    event_date  INTEGER,
    metadata    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_person     ON memories(person);
  CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_type       ON memories(type);
  CREATE INDEX IF NOT EXISTS idx_chat_id    ON memories(chat_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    person,
    topic,
    summary,
    content='memories',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS fts_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, person, topic, summary)
    VALUES (new.id, new.content, COALESCE(new.person,''), COALESCE(new.topic,''), COALESCE(new.summary,''));
  END;

  CREATE TRIGGER IF NOT EXISTS fts_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, person, topic, summary)
    VALUES ('delete', old.id, old.content, COALESCE(old.person,''), COALESCE(old.topic,''), COALESCE(old.summary,''));
  END;

  CREATE TRIGGER IF NOT EXISTS fts_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, person, topic, summary)
    VALUES ('delete', old.id, old.content, COALESCE(old.person,''), COALESCE(old.topic,''), COALESCE(old.summary,''));
    INSERT INTO memories_fts(rowid, content, person, topic, summary)
    VALUES (new.id, new.content, COALESCE(new.person,''), COALESCE(new.topic,''), COALESCE(new.summary,''));
  END;
`);

// ── Queries ────────────────────────────────────────────────────────────────────

export function addMemory({ type = 'conversation', content, summary, person, chatId, topic, source = 'manual', createdAt, eventDate, metadata }) {
  const stmt = db.prepare(`
    INSERT INTO memories (type, content, summary, person, chat_id, topic, source, created_at, event_date, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    type, content, summary ?? null, person ?? null, chatId ?? null,
    topic ?? null, source, createdAt ?? Date.now(), eventDate ?? null,
    metadata ? JSON.stringify(metadata) : null
  );
  return result.lastInsertRowid;
}

export function searchMemories({ query, person, dateFrom, dateTo, topic, type, limit = 20 }) {
  // Full-text search if query provided, otherwise filter-only
  if (query) {
    // Sanitize query for FTS5 (escape special chars)
    const ftsQuery = query.replace(/["]/g, '""');
    let sql = `
      SELECT m.*, rank
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
    `;
    const params = [ftsQuery];

    if (person) { sql += ` AND m.person LIKE ?`; params.push(`%${person}%`); }
    if (dateFrom) { sql += ` AND m.created_at >= ?`; params.push(dateFrom); }
    if (dateTo) { sql += ` AND m.created_at <= ?`; params.push(dateTo); }
    if (topic) { sql += ` AND m.topic LIKE ?`; params.push(`%${topic}%`); }
    if (type) { sql += ` AND m.type = ?`; params.push(type); }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    try {
      return db.prepare(sql).all(...params);
    } catch {
      // FTS syntax error — fall back to LIKE search
      return likeSearch({ query, person, dateFrom, dateTo, topic, type, limit });
    }
  }

  return filterSearch({ person, dateFrom, dateTo, topic, type, limit });
}

function likeSearch({ query, person, dateFrom, dateTo, topic, type, limit }) {
  let sql = `SELECT * FROM memories WHERE content LIKE ?`;
  const params = [`%${query}%`];
  if (person) { sql += ` AND person LIKE ?`; params.push(`%${person}%`); }
  if (dateFrom) { sql += ` AND created_at >= ?`; params.push(dateFrom); }
  if (dateTo) { sql += ` AND created_at <= ?`; params.push(dateTo); }
  if (topic) { sql += ` AND topic LIKE ?`; params.push(`%${topic}%`); }
  if (type) { sql += ` AND type = ?`; params.push(type); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function filterSearch({ person, dateFrom, dateTo, topic, type, limit }) {
  let sql = `SELECT * FROM memories WHERE 1=1`;
  const params = [];
  if (person) { sql += ` AND person LIKE ?`; params.push(`%${person}%`); }
  if (dateFrom) { sql += ` AND created_at >= ?`; params.push(dateFrom); }
  if (dateTo) { sql += ` AND created_at <= ?`; params.push(dateTo); }
  if (topic) { sql += ` AND topic LIKE ?`; params.push(`%${topic}%`); }
  if (type) { sql += ` AND type = ?`; params.push(type); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getRecentMemories({ limit = 20, person, type, chatId } = {}) {
  let sql = `SELECT * FROM memories WHERE 1=1`;
  const params = [];
  if (person) { sql += ` AND person LIKE ?`; params.push(`%${person}%`); }
  if (type) { sql += ` AND type = ?`; params.push(type); }
  if (chatId) { sql += ` AND chat_id = ?`; params.push(chatId); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as n FROM memories`).get();
  const byType = db.prepare(`SELECT type, COUNT(*) as n FROM memories GROUP BY type`).all();
  const bySource = db.prepare(`SELECT source, COUNT(*) as n FROM memories GROUP BY source`).all();
  const oldest = db.prepare(`SELECT MIN(created_at) as t FROM memories`).get();
  const dbSize = db.prepare(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()`).get();
  return { total: total.n, byType, bySource, oldestEntry: oldest.t, dbSizeBytes: dbSize?.size ?? 0 };
}

export function deleteMemory(id) {
  return db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}

export { db };
