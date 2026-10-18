// PM2 ecosystem - central process registry for all server-hub services.
// Start all:   pm2 start ecosystem.config.js
// Save state:  pm2 save
// Monitor:     pm2 monit
//
// Paths are derived from this file's location, so the repo works no matter where
// it is cloned or which user runs it. Memory limits are sized for an 8 GB server.

const path = require('path');
const ROOT = __dirname;
const log = (f) => path.join(ROOT, 'logs', f);

module.exports = {
  apps: [
    // Phase 3: custom Web UI (bridges browsers to the claude CLI).
    {
      name: 'hub-webui',
      script: 'server.js',
      cwd: path.join(ROOT, 'webui'),
      watch: false,
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: log('hub-webui-error.log'),
      out_file: log('hub-webui-out.log'),
      env: { NODE_ENV: 'production' }
    },

    // Phase 4: persistent WhatsApp daemon. Owns the single WhatsApp connection,
    // runs the /claude trigger + auto-replies, and serves the localhost control
    // API (port 8091) that the whatsapp-bridge MCP forwards to. Runs Chromium via
    // puppeteer for WhatsApp Web, hence the higher memory ceiling.
    {
      name: 'whatsapp-mcp',
      script: 'index.js',
      cwd: path.join(ROOT, 'whatsapp-mcp'),
      watch: false,
      max_memory_restart: '700M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: log('whatsapp-mcp-error.log'),
      out_file: log('whatsapp-mcp-out.log'),
      // WA_DAEMON=1 -> serve control API + /claude only (no stdio MCP).
      // Incoming /claude = sandboxed chatbot; your own (fromMe) = full agent.
      // HUB_WEBUI_PORT lets /claude-webui report the right URL.
      env: { NODE_ENV: 'production', WA_DAEMON: '1', HUB_WEBUI_PORT: '8088' }
    },

    // Feature 3: Memory store — SQLite-backed persistent memory with FTS5 search
    {
      name: 'memory-store',
      script: 'index.js',
      cwd: path.join(ROOT, 'memory-store'),
      watch: false,
      max_memory_restart: '150M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: log('memory-store-error.log'),
      out_file: log('memory-store-out.log'),
      env: { NODE_ENV: 'production' }
    },

    // Feature 2: Gmail monitor — polls multiple inboxes, sends WhatsApp digest
    // for important emails. Start only after running: node gmail-monitor/setup.js add <email>
    {
      name: 'gmail-monitor',
      script: 'index.js',
      cwd: path.join(ROOT, 'gmail-monitor'),
      watch: false,
      max_memory_restart: '150M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: log('gmail-monitor-error.log'),
      out_file: log('gmail-monitor-out.log'),
      env: { NODE_ENV: 'production' }
    },

    // Feature 8: Price Tracker — Playwright scraper + SQLite, polls prices and
    // sends WhatsApp drop alerts. Start after running: npm install in price-tracker/
    {
      name: 'price-tracker',
      script: 'index.js',
      cwd: path.join(ROOT, 'price-tracker'),
      watch: false,
      max_memory_restart: '300M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: log('price-tracker-error.log'),
      out_file: log('price-tracker-out.log'),
      env: { NODE_ENV: 'production' }
    },

    // Playwright MCP is NOT a PM2 service - Claude spawns it on-demand (stdio)
    // only when it needs a browser, so it costs ~0 idle RAM. It is registered at
    // user scope by scripts/setup.ps1.
  ]
}
