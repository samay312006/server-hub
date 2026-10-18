// Price Tracker Daemon — Feature 8
// Tracks product prices via Playwright scraping. Polls on a schedule and sends
// WhatsApp alerts when a price drops to or below the user's target.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

import {
  addProduct, getProduct, listProducts, updatePrice,
  updateProductName, removeProduct, getPriceHistory, getStats,
} from './db.js';
import { scrapePrice } from './scraper.js';

const PORT = parseInt(process.env.PRICE_TRACKER_PORT || '8095', 10);
const INTERVAL_MS = parseInt(process.env.PRICE_CHECK_INTERVAL_MINUTES || '30', 10) * 60 * 1000;
const WA_CONTROL_URL = process.env.WA_CONTROL_URL || 'http://127.0.0.1:8091';
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '';

// ── WhatsApp sender ────────────────────────────────────────────────────────────
async function sendWhatsApp(chatId, message) {
  const target = chatId || OWNER_CHAT_ID;
  if (!target) { console.error('[wa] No chat ID configured'); return false; }
  try {
    const res = await fetch(`${WA_CONTROL_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: target, message }),
    });
    return res.ok;
  } catch (e) {
    console.error('[wa] Send failed:', e.message);
    return false;
  }
}

function fmtPrice(price, currency = 'INR') {
  const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '₹';
  return `${symbol}${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// ── Single product checker ─────────────────────────────────────────────────────
async function checkProduct(product) {
  console.log(`[check] #${product.id} ${(product.name || product.url).slice(0, 60)}`);
  let result;
  try {
    result = await scrapePrice(product.url, product.selector);
  } catch (e) {
    console.error(`[check] #${product.id} scrape error: ${e.message}`);
    return;
  }

  if (!result.price) {
    console.log(`[check] #${product.id} price not found: ${result.error || 'unknown'}`);
    return;
  }

  // Auto-save name on first scrape
  if (!product.name && result.name) {
    updateProductName(product.id, result.name);
  }

  const prevPrice = product.current_price;
  updatePrice(product.id, result.price);

  const displayName = product.name || result.name || product.url.slice(0, 60);
  console.log(`[check] #${product.id} ${displayName.slice(0, 50)} — ${fmtPrice(result.price, result.currency)}`);

  // Price drop alert: price fell AND (no target OR hit/beat target)
  const priceFell = prevPrice && result.price < prevPrice;
  const hitTarget = product.target_price && result.price <= product.target_price;

  if (hitTarget || (priceFell && !product.target_price)) {
    const drop = prevPrice ? ((prevPrice - result.price) / prevPrice * 100).toFixed(1) : null;
    let msg = `🎯 *Price Alert!*\n\n`;
    msg += `*${displayName.slice(0, 80)}*\n`;
    msg += `💰 *Now: ${fmtPrice(result.price, result.currency)}*\n`;
    if (prevPrice) msg += `📉 Was: ${fmtPrice(prevPrice, result.currency)} (${drop}% drop)\n`;
    if (product.target_price) msg += `🎯 Your target: ${fmtPrice(product.target_price, result.currency)}\n`;
    msg += `\n🛒 ${product.url}`;
    await sendWhatsApp(product.chat_id, msg);
    console.log(`[alert] Sent price drop alert for #${product.id}`);
  }
}

// ── Poll cycle ─────────────────────────────────────────────────────────────────
let isChecking = false;

async function checkAll(manual = false) {
  if (isChecking) { console.log('[check] Already running, skipping'); return; }
  isChecking = true;
  const products = listProducts({ activeOnly: true });
  if (!products.length) {
    console.log('[check] No products tracked.');
    isChecking = false;
    return;
  }
  console.log(`[check] Checking ${products.length} product(s)…`);
  for (const p of products) {
    await checkProduct(p);
    // Brief pause between requests to be polite
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('[check] Done.');
  isChecking = false;
}

// ── HTTP Control API ───────────────────────────────────────────────────────────
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
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(200, { running: true, checking: isChecking, intervalMin: INTERVAL_MS / 60000, ...getStats() });
    }

    // GET /list
    if (req.method === 'GET' && url.pathname === '/list') {
      const chatId = url.searchParams.get('chatId') || undefined;
      return sendJson(200, { products: listProducts({ chatId }) });
    }

    // POST /track — { url, name?, targetPrice?, chatId?, selector? }
    if (req.method === 'POST' && url.pathname === '/track') {
      if (!p.url) return sendJson(400, { error: 'url required' });
      const id = addProduct(p);
      // Kick off an immediate first check in background
      getProduct(id) && checkProduct(getProduct(id)).catch(() => {});
      return sendJson(200, { ok: true, id });
    }

    // DELETE /untrack/:id
    if (req.method === 'DELETE' && url.pathname.startsWith('/untrack/')) {
      const id = parseInt(url.pathname.split('/')[2], 10);
      if (!id) return sendJson(400, { error: 'invalid id' });
      removeProduct(id);
      return sendJson(200, { ok: true });
    }

    // GET /history/:id
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = parseInt(url.pathname.split('/')[2], 10);
      if (!id) return sendJson(400, { error: 'invalid id' });
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      return sendJson(200, { history: getPriceHistory(id, limit) });
    }

    // POST /check-now — trigger an immediate manual poll
    if (req.method === 'POST' && url.pathname === '/check-now') {
      if (isChecking) return sendJson(200, { ok: true, message: 'Check already in progress' });
      checkAll(true).catch(e => console.error('[check-now] Error:', e.message));
      return sendJson(200, { ok: true, message: 'Check started' });
    }

    return sendJson(404, { error: 'not found' });
  });
}).listen(PORT, '127.0.0.1', () => {
  const stats = getStats();
  console.log(`🛒 Price Tracker running on http://127.0.0.1:${PORT}`);
  console.log(`📊 ${stats.tracked} product(s) tracked | checking every ${INTERVAL_MS / 60000} min`);
});

// ── Start polling ──────────────────────────────────────────────────────────────
setTimeout(checkAll, 30 * 1000);         // first check after 30s startup delay
setInterval(checkAll, INTERVAL_MS);      // recurring checks
