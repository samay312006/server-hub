// Price Tracker database — uses Node.js built-in node:sqlite (Node 22.5+)
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'prices.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    url           TEXT    NOT NULL,
    name          TEXT,
    selector      TEXT,
    target_price  REAL,
    current_price REAL,
    currency      TEXT    DEFAULT 'INR',
    last_checked  INTEGER,
    chat_id       TEXT,
    added_at      INTEGER NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price      REAL    NOT NULL,
    checked_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_history_product ON price_history(product_id, checked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_products_active  ON products(active);
`);

export function addProduct({ url, name, targetPrice, chatId, selector, currency = 'INR' }) {
  const stmt = db.prepare(`
    INSERT INTO products (url, name, selector, target_price, currency, chat_id, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(url, name ?? null, selector ?? null, targetPrice ?? null, currency, chatId ?? null, Date.now());
  return result.lastInsertRowid;
}

export function getProduct(id) {
  return db.prepare(`SELECT * FROM products WHERE id = ?`).get(id);
}

export function listProducts({ chatId, activeOnly = true } = {}) {
  let sql = `SELECT * FROM products WHERE 1=1`;
  const params = [];
  if (activeOnly) { sql += ` AND active = 1`; }
  if (chatId) { sql += ` AND chat_id = ?`; params.push(chatId); }
  sql += ` ORDER BY added_at DESC`;
  return db.prepare(sql).all(...params);
}

export function updatePrice(id, price) {
  db.prepare(`UPDATE products SET current_price = ?, last_checked = ? WHERE id = ?`).run(price, Date.now(), id);
  db.prepare(`INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)`).run(id, price, Date.now());
}

export function updateProductName(id, name) {
  db.prepare(`UPDATE products SET name = ? WHERE id = ?`).run(name, id);
}

export function removeProduct(id) {
  db.prepare(`UPDATE products SET active = 0 WHERE id = ?`).run(id);
}

export function getPriceHistory(productId, limit = 20) {
  return db.prepare(`SELECT * FROM price_history WHERE product_id = ? ORDER BY checked_at DESC LIMIT ?`).all(productId, limit);
}

export function getStats() {
  const total = db.prepare(`SELECT COUNT(*) as n FROM products WHERE active = 1`).get();
  const withTarget = db.prepare(`SELECT COUNT(*) as n FROM products WHERE active = 1 AND target_price IS NOT NULL`).get();
  const alerts = db.prepare(`
    SELECT COUNT(*) as n FROM products
    WHERE active = 1 AND target_price IS NOT NULL AND current_price IS NOT NULL AND current_price <= target_price
  `).get();
  return { tracked: total.n, withTarget: withTarget.n, activeAlerts: alerts.n };
}

export { db };
