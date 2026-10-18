'use strict';

const http = require('http');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// ws + ssh2 power the in-browser terminal (see setupTerminalBridge). Loaded
// lazily so a missing dep degrades the terminal feature instead of the whole hub.
let WebSocketServer = null, SSHClient = null;
try { WebSocketServer = require('ws').WebSocketServer; SSHClient = require('ssh2').Client; }
catch (e) { console.error('[term] ws/ssh2 not installed — web terminal disabled:', e.message); }

loadDotEnv(path.join(__dirname, '.env'));

// A handler bug must not take down the hub (and wipe everyone's sessions).
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(__dirname, '_crash.log'), new Date().toISOString() + ' ' + (err.stack || err) + '\n'); } catch (_) {}
  console.error('[uncaught]', err && err.message);
});

const os = require('os');

const CFG = {
  port: parseInt(process.env.HUB_PORT || '8088', 10),
  bind: process.env.HUB_BIND || '0.0.0.0',
  password: process.env.HUB_PASSWORD || '',
  guestPassword: process.env.HUB_GUEST_PASSWORD || '',
  model: process.env.HUB_MODEL || 'opus',
  workdir: process.env.HUB_WORKDIR || 'C:\\server-hub',
  permissionMode: process.env.HUB_PERMISSION_MODE || 'bypassPermissions',
  turnTimeoutMs: parseInt(process.env.HUB_TURN_TIMEOUT_MS || '600000', 10),
  // ---- multi-device ----
  // role is informational (both nodes run the same server); the GUI is just
  // pointed at the canonical 'hub' node. deviceToken gates the /agent/* surface
  // that lets the hub proxy to peers over Tailscale; share it across all nodes.
  role: process.env.HUB_ROLE || 'hub',
  deviceId: (process.env.HUB_DEVICE_ID || os.hostname() || 'this').toLowerCase(),
  deviceToken: process.env.HUB_DEVICE_TOKEN || '',
};

// Device registry — peers reachable over Tailscale. No secrets here (shared
// deviceToken lives in .env), so this file is safe to commit.
const DEVICES_FILE = path.join(__dirname, 'devices.json');
function loadDevices() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch (_) {}
  if (!Array.isArray(list)) list = [];
  return list.map((d) => ({
    id: String(d.id || '').toLowerCase(),
    name: d.name || d.id,
    host: d.host || '',
    agentPort: parseInt(d.agentPort || CFG.port, 10) || CFG.port,
    kind: d.kind || 'agent',
    // SSH login used by the web terminal / VS Code Remote-SSH bridge.
    sshUser: d.sshUser || process.env.HUB_SSH_USER || os.userInfo().username,
    sshPort: parseInt(d.sshPort || 22, 10) || 22,
  })).filter((d) => d.id);
}
function saveDevices(list) { try { fs.writeFileSync(DEVICES_FILE, JSON.stringify(list, null, 2)); } catch (_) {} }
let DEVICES = loadDevices();
const findDevice = (id) => DEVICES.find((d) => d.id === String(id || '').toLowerCase());
const isSelfDevice = (id) => !id || String(id).toLowerCase() === CFG.deviceId;

// Tools guests may never use — blocks all filesystem, shell, and machine access.
const GUEST_DISALLOWED_TOOLS = [
  'Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'NotebookRead', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite',
  'Skill', 'SlashCommand', 'ExitPlanMode', 'KillShell', 'BashOutput', 'ToolSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'mcp__*',
].join(',');

const CONV_DIR = path.join(__dirname, 'conversations');
const WORKFLOWS_FILE = path.join(__dirname, 'workflows.json');
const PROJECTS_FILE = path.join(__dirname, 'projects.json');
const HUB_CONFIG_FILE = path.join(__dirname, 'hub-config.json');
const PARAMS_FILE = path.join(__dirname, 'params.json');
const TASKS_FILE = path.join(path.dirname(__dirname), 'claude-tasks.json');

try { fs.mkdirSync(CONV_DIR, { recursive: true }); } catch (_) {}

try {
  const c = JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8'));
  if (c.model) CFG.model = c.model;
  if (c.workdir) CFG.workdir = c.workdir;
} catch (_) {}

const CLAUDE = resolveClaude();
console.log('  claude binary: ' + CLAUDE.command);

function resolveClaude() {
  if (process.env.HUB_CLAUDE_EXE && fs.existsSync(process.env.HUB_CLAUDE_EXE)) {
    return { command: process.env.HUB_CLAUDE_EXE, prefix: [], shell: false };
  }
  if (process.platform === 'win32') {
    const guesses = [
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
    ];
    for (const g of guesses) {
      try { if (g && fs.existsSync(g)) return { command: g, prefix: [], shell: false }; } catch (_) {}
    }
    return { command: process.env.SystemRoot + '\\System32\\cmd.exe', prefix: ['/d', '/s', '/c', 'claude'], shell: false };
  }
  return { command: 'claude', prefix: [], shell: false };
}

if (!CFG.password) {
  CFG.password = crypto.randomBytes(6).toString('base64url');
  console.log('\n  [!] HUB_PASSWORD not set. Generated temporary: ' + CFG.password + '\n');
}

const validTokens = new Map(); // token -> 'owner' | 'guest'
function issueToken(role) { const t = crypto.randomUUID(); validTokens.set(t, role); return t; }
function isAuthed(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/hub_auth=([^;]+)/);
  return (m && validTokens.get(m[1])) || null;
}

// Maps app sessionId -> { claudeSessionId, started, convId }
const sessions = new Map();

// ---------- conversation persistence ----------
function convPath(id) { return path.join(CONV_DIR, id + '.json'); }
function loadConv(id) {
  try { return JSON.parse(fs.readFileSync(convPath(id), 'utf8')); } catch (_) { return null; }
}
function saveConv(conv) {
  conv.updatedAt = new Date().toISOString();
  fs.writeFileSync(convPath(conv.id), JSON.stringify(conv, null, 2));
}
function createConv(id, model, workdir) {
  const conv = { id, title: '', model, workdir, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  saveConv(conv);
  return conv;
}
function listConvs() {
  try {
    return fs.readdirSync(CONV_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(CONV_DIR, f), 'utf8'));
          return { id: c.id, title: c.title || 'Untitled', model: c.model, workdir: c.workdir || '', updatedAt: c.updatedAt, createdAt: c.createdAt, messages: Array.isArray(c.messages) ? c.messages.length : 0 };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch (_) { return []; }
}

// ---------- workflows ----------
function loadWorkflows() {
  try { return JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8')); } catch (_) { return []; }
}
function saveWorkflows(wf) { fs.writeFileSync(WORKFLOWS_FILE, JSON.stringify(wf, null, 2)); }

// ---------- projects ----------
function normWorkdir(d) { return String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function loadHiddenProjects() {
  try { return JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8')).hiddenProjects || []; } catch (_) { return []; }
}
function addHiddenProject(workdir) {
  try {
    const saved = {};
    try { Object.assign(saved, JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8'))); } catch (_) {}
    const h = new Set(saved.hiddenProjects || []);
    h.add(normWorkdir(workdir));
    saved.hiddenProjects = [...h];
    fs.writeFileSync(HUB_CONFIG_FILE, JSON.stringify(saved, null, 2));
  } catch (_) {}
}
function loadProjects() {
  let projects;
  try { projects = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); } catch (_) {
    projects = [{ id: 'default', name: 'server-hub', workdir: 'C:\\server-hub', description: 'Main hub project', active: true }];
  }
  // Auto-discover every directory Claude Code has been used in (~/.claude.json
  // "projects" map). Deleted entries land in hub-config.json hiddenProjects so
  // they don't resurrect on the next sync.
  const hidden = new Set(loadHiddenProjects());
  const known = new Set(projects.map(pr => normWorkdir(pr.workdir)));
  try {
    const cj = loadClaudeJson();
    for (const dir of Object.keys(cj.projects || {})) {
      const norm = normWorkdir(dir);
      if (!norm || known.has(norm) || hidden.has(norm)) continue;
      known.add(norm);
      projects.push({
        id: 'auto-' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10),
        name: path.basename(dir) || dir,
        workdir: dir.replace(/\//g, '\\'),
        description: 'Auto-discovered from Claude Code',
        auto: true,
        active: false,
      });
    }
  } catch (_) {}
  return projects;
}
function saveProjects(p) { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(p, null, 2)); }

// ---------- connectors (MCP servers in ~/.claude.json) ----------
function claudeJsonPath() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude.json');
}
function loadClaudeJson() {
  try { return JSON.parse(fs.readFileSync(claudeJsonPath(), 'utf8')); } catch (_) { return {}; }
}
function saveClaudeJson(obj) {
  fs.writeFileSync(claudeJsonPath(), JSON.stringify(obj, null, 2));
}

// ---------- model effort (user-level Claude settings) ----------
const USER_SETTINGS_FILE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'settings.json');
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];
function readEffort() {
  try { return JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8')).effortLevel || 'high'; } catch (_) { return 'high'; }
}
function writeEffort(level) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(USER_SETTINGS_FILE, 'utf8')); } catch (_) {}
  s.effortLevel = level;
  fs.writeFileSync(USER_SETTINGS_FILE, JSON.stringify(s, null, 2));
}

// ---------- live usage limits (same endpoint Claude Code's /usage uses) ----------
// Reads the OAuth token at request time; only utilization %s ever leave the server.
const USAGE_LABELS = {
  five_hour: 'Session (5h)',
  seven_day: 'Weekly · all models',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_opus: 'Weekly · Opus',
  seven_day_oauth_apps: 'Weekly · apps',
};
// Cache BOTH successes and failures (the endpoint 429s if polled too hard),
// and serve the last good reading marked stale when a refresh fails.
let usageCache = { at: 0, data: null, ttl: 60000 };
let usageGood = null;
function handleUsage(res) {
  if (usageCache.data && Date.now() - usageCache.at < usageCache.ttl) return sendJson(res, 200, usageCache.data);
  const fail = (error, ttl = 60000) => {
    const data = usageGood ? { ...usageGood, stale: true } : { ok: false, error };
    usageCache = { at: Date.now(), data, ttl };
    sendJson(res, 200, data);
  };
  let token = '';
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', '.credentials.json'), 'utf8'));
    token = (cred.claudeAiOauth && cred.claudeAiOauth.accessToken) || '';
  } catch (_) {}
  if (!token) return fail('no Claude OAuth token on this machine');
  const up = require('https').request({
    hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
    headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
  }, (r) => {
    let d = '';
    r.on('data', (c) => { d += c; });
    r.on('end', () => {
      try {
        const raw = JSON.parse(d);
        const windows = [];
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v === 'object' && v.utilization != null) {
            const pct = v.utilization <= 1 ? v.utilization * 100 : v.utilization;
            windows.push({ id: k, label: USAGE_LABELS[k] || k, pct: Math.round(pct), resetsAt: v.resets_at || null });
          }
        }
        // 429 = our own backoff failed upstream; chill for 5 minutes
        if (!windows.length) return fail('rate-limited or unexpected response (' + r.statusCode + ')', r.statusCode === 429 ? 300000 : 60000);
        const data = { ok: true, windows, fetchedAt: Date.now() };
        usageGood = data;
        usageCache = { at: Date.now(), data, ttl: 60000 };
        sendJson(res, 200, data);
      } catch (_) { fail('bad response (' + r.statusCode + ')'); }
    });
  });
  up.on('error', (e) => fail(String(e.message || e)));
  up.setTimeout(8000, () => { up.destroy(); fail('timeout'); });
  up.end();
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  // Agent surface: peers reach this node at /agent/<path> with a shared device
  // token instead of the browser cookie. Strip the prefix and treat as owner.
  let agentOwner = false;
  if (req.url.startsWith('/agent/') || req.url === '/agent') {
    if (!CFG.deviceToken || req.headers['x-device-token'] !== CFG.deviceToken) return sendJson(res, 401, { error: 'bad device token' });
    req.url = req.url.slice('/agent'.length) || '/';
    agentOwner = true;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') return serveIndex(res);
  if (req.method === 'GET' && p === '/legacy') return serveFile(res, path.join(__dirname, 'public', 'index.html'), '.html');
  if (req.method === 'GET' && (p.startsWith('/assets/') || p === '/favicon.svg' || p === '/manifest.json' || p === '/sw.js' || p === '/icon.svg')) return serveDist(res, p);
  if (req.method === 'GET' && p === '/healthz') return sendJson(res, 200, { ok: true });
  if (req.method === 'POST' && p === '/api/login') return handleLogin(req, res);

  const role = agentOwner ? 'owner' : isAuthed(req);
  if (!role) return sendJson(res, 401, { error: 'unauthorized' });
  const ownerOnly = () => { sendJson(res, 403, { error: 'owner only' }); };

  // Device fan-out: any owner API call with ?device=<peer> is proxied to that
  // peer's /agent surface over Tailscale (works for JSON and SSE alike). Agent
  // requests never re-proxy, preventing loops.
  if (!agentOwner && role === 'owner' && p.startsWith('/api/')) {
    const deviceId = url.searchParams.get('device');
    if (deviceId && !isSelfDevice(deviceId)) {
      const dev = findDevice(deviceId);
      if (!dev || !dev.host) return sendJson(res, 404, { error: 'unknown device' });
      return proxyToDevice(dev, req, res, url);
    }
  }
  // Device registry + this node's health (health is reachable by peers too).
  if (req.method === 'GET' && p === '/api/device/health') return handleDeviceHealth(res);
  if (req.method === 'GET' && p === '/api/device/pubkey') return handleDevicePubkey(res);
  if (p.startsWith('/api/devices') && role !== 'owner') return ownerOnly();
  if (req.method === 'GET' && p === '/api/devices') return handleDevicesList(res);
  if (req.method === 'POST' && p === '/api/devices') return handleDevicesPost(req, res);
  if (req.method === 'DELETE' && p.startsWith('/api/devices/')) return handleDevicesDelete(p, res);

  if (req.method === 'GET' && p === '/api/wa-status') return handleWAStatus(res);
  if (req.method === 'GET' && p === '/api/usage') return role === 'owner' ? handleUsage(res) : ownerOnly();

  // Files / git / GitHub / logs / analytics — all owner-only
  if ((p.startsWith('/api/files') || p.startsWith('/api/git') || p.startsWith('/api/github') ||
       p === '/api/upload' || p === '/api/logs' || p === '/api/analytics') && role !== 'owner') return ownerOnly();
  if (req.method === 'GET' && p === '/api/files') return handleFilesList(url, res);
  if (req.method === 'GET' && p === '/api/files/read') return handleFileRead(url, res);
  if (req.method === 'GET' && p === '/api/files/raw') return handleFileRaw(url, res);
  if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res);
  if (req.method === 'GET' && p === '/api/git/status') return handleGitStatus(res);
  if (req.method === 'GET' && p === '/api/git/diff') return handleGitDiff(url, res);
  if (req.method === 'GET' && p === '/api/git/branches') return handleGitBranches(res);
  if (req.method === 'POST' && p === '/api/git/commit') return handleGitCommit(req, res);
  if (req.method === 'POST' && p === '/api/git/ai-message') return handleGitAiMsg(res);
  if (req.method === 'POST' && p === '/api/git/stage') return handleGitStage(req, res);
  if (req.method === 'POST' && p === '/api/git/unstage') return handleGitUnstage(req, res);
  if (req.method === 'POST' && p === '/api/git/discard') return handleGitDiscard(req, res);
  if (req.method === 'POST' && p === '/api/git/fetch') return handleGitFetch(res);
  if (req.method === 'POST' && p === '/api/git/pull') return handleGitPull(res);
  if (req.method === 'POST' && p === '/api/git/push') return handleGitPush(req, res);
  if (req.method === 'POST' && p === '/api/git/branch') return handleGitBranch(req, res);
  if (req.method === 'POST' && p === '/api/git/branch-delete') return handleGitBranchDelete(req, res);
  if (req.method === 'POST' && p === '/api/git/stash') return handleGitStash(req, res);
  if (req.method === 'POST' && p === '/api/git/merge') return handleGitMerge(req, res);
  if (req.method === 'POST' && p === '/api/git/resolve') return handleGitResolve(req, res);
  if (req.method === 'POST' && p === '/api/git/abort') return handleGitAbort(req, res);
  if (req.method === 'GET' && p === '/api/github') return handleGitHub(res);
  if (req.method === 'GET' && p === '/api/github/accounts') return handleGhAccounts(res);
  if (req.method === 'POST' && p === '/api/github/switch') return handleGhSwitch(req, res);
  if (req.method === 'GET' && p === '/api/logs') return handleLogs(url, res);
  if (req.method === 'GET' && p === '/api/analytics') return handleAnalytics(res);
  if (req.method === 'GET' && p === '/api/dashboard') return role === 'owner' ? handleDashboard(res) : ownerOnly();
  // Live Claude-session mirror (owner only — reveals cwd + transcript content)
  if (req.method === 'GET' && p === '/api/sessions') return role === 'owner' ? handleSessionsList(res) : ownerOnly();
  if (req.method === 'GET' && /^\/api\/sessions\/[\w-]+\/stream$/.test(p)) return role === 'owner' ? handleSessionStream(res, p.split('/')[3]) : ownerOnly();
  // Skills manager (owner only) — CRUD on ~/.claude/skills + project .claude/skills
  if (p.startsWith('/api/skills') && role !== 'owner') return ownerOnly();
  if (req.method === 'GET' && p === '/api/skills') return handleSkillsList(res);
  if (req.method === 'POST' && p === '/api/skills') return handleSkillsPost(req, res);
  if (req.method === 'GET' && p.startsWith('/api/skills/')) return handleSkillGet(res, decodeURIComponent(p.slice('/api/skills/'.length)));
  if (req.method === 'PUT' && p.startsWith('/api/skills/')) return handleSkillPut(req, res, decodeURIComponent(p.slice('/api/skills/'.length)));
  if (req.method === 'DELETE' && p.startsWith('/api/skills/')) return handleSkillDelete(res, decodeURIComponent(p.slice('/api/skills/'.length)));
  // Task bridge (owner only) — start headless Claude on this/any device
  if (p.startsWith('/api/tasks') && role !== 'owner') return ownerOnly();
  if (req.method === 'GET' && p === '/api/tasks') return handleTasksList(res);
  if (req.method === 'POST' && p === '/api/tasks') return handleTasksPost(req, res);
  if (req.method === 'POST' && /^\/api\/tasks\/[\w-]+\/stop$/.test(p)) return handleTaskStop(res, p.split('/')[3]);
  if (req.method === 'GET' && p === '/api/params') return handleGetParams(res);
  if (req.method === 'POST' && p === '/api/params') return role === 'owner' ? handlePostParams(req, res) : ownerOnly();
  if (req.method === 'POST' && p === '/api/command') return role === 'owner' ? handleCommand(req, res) : ownerOnly();
  if (req.method === 'POST' && p === '/api/chat') return handleChat(req, res, role);

  // Conversations — guests only ever see their own (guest-*) conversations
  if (req.method === 'POST' && /^\/api\/conversations\/[^/]+\/fork$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    if (role !== 'owner' && !id.startsWith('guest-')) return ownerOnly();
    const conv = loadConv(id);
    if (!conv) return sendJson(res, 404, { error: 'not found' });
    const newId = (role === 'guest' ? 'guest-' : '') + crypto.randomUUID();
    const copy = { ...conv, id: newId, title: (conv.title || 'Untitled') + ' (branch)', createdAt: new Date().toISOString() };
    saveConv(copy);
    return sendJson(res, 200, copy);
  }
  if (req.method === 'POST' && /^\/api\/conversations\/[^/]+\/truncate$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    if (role !== 'owner' && !id.startsWith('guest-')) return ownerOnly();
    return readBody(req, (body) => {
      let keep = 0;
      try { keep = Math.max(0, parseInt(JSON.parse(body).keep, 10) || 0); } catch (_) {}
      const conv = loadConv(id);
      if (!conv) return sendJson(res, 404, { error: 'not found' });
      conv.messages = conv.messages.slice(0, keep);
      saveConv(conv);
      // Drop any live Claude session for this conv — the next turn starts fresh
      // and the history-replay block in handleChat restores context.
      for (const [sid, sess] of sessions.entries()) { if (sess.convId === id) sessions.delete(sid); }
      sendJson(res, 200, { ok: true, messages: conv.messages.length });
    });
  }
  // Compress a long conversation: summarize all but the last `keep` messages
  // into one recap message (saves context + tokens on replay).
  if (req.method === 'POST' && /^\/api\/conversations\/[^/]+\/compress$/.test(p)) {
    const id = decodeURIComponent(p.split('/')[3]);
    if (role !== 'owner' && !id.startsWith('guest-')) return ownerOnly();
    return readBody(req, (body) => {
      let keep = 6;
      try { const k = parseInt(JSON.parse(body).keep, 10); if (k >= 0) keep = k; } catch (_) {}
      const conv = loadConv(id);
      if (!conv) return sendJson(res, 404, { error: 'not found' });
      const msgs = conv.messages || [];
      if (msgs.length <= keep + 2) return sendJson(res, 200, { ok: true, messages: msgs.length, skipped: true });
      const head = msgs.slice(0, msgs.length - keep);
      const tail = msgs.slice(msgs.length - keep);
      let transcript = head.map((m) => (m.role === 'user' ? 'User' : 'Assistant') + ': ' + m.text).join('\n\n');
      if (transcript.length > 12000) transcript = transcript.slice(-12000);
      const ch = spawn(CLAUDE.command, [...CLAUDE.prefix, '-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'text'], { cwd: CFG.workdir, shell: CLAUDE.shell, windowsHide: true });
      let out = '';
      ch.stdout.on('data', (c) => { out += c; });
      const t = setTimeout(() => { try { ch.kill(); } catch (_) {} }, 60000);
      ch.on('error', () => { clearTimeout(t); sendJson(res, 200, { ok: false, error: 'compress failed' }); });
      ch.on('close', () => {
        clearTimeout(t);
        const summary = out.trim();
        if (!summary) return sendJson(res, 200, { ok: false, error: 'no summary produced' });
        conv.messages = [{ role: 'assistant', text: '🗜 **Earlier conversation (compressed):**\n\n' + summary.slice(0, 6000), ts: Date.now(), compressed: true }, ...tail];
        saveConv(conv);
        for (const [sid, sess] of sessions.entries()) { if (sess.convId === id) sessions.delete(sid); }
        sendJson(res, 200, { ok: true, messages: conv.messages.length });
      });
      ch.stdin.write('Summarize this conversation so it can be continued later without losing important context. Keep key decisions, facts, file paths, and open threads. Be concise (bullet points ok):\n\n' + transcript);
      ch.stdin.end();
    });
  }
  if (req.method === 'PATCH' && p.startsWith('/api/conversations/')) {
    const id = decodeURIComponent(p.slice('/api/conversations/'.length));
    if (role !== 'owner' && !id.startsWith('guest-')) return ownerOnly();
    return readBody(req, (body) => {
      let title = '';
      try { title = (JSON.parse(body).title || '').toString().trim().slice(0, 120); } catch (_) {}
      const conv = loadConv(id);
      if (!conv) return sendJson(res, 404, { error: 'not found' });
      if (title) conv.title = title;
      saveConv(conv);
      sendJson(res, 200, { ok: true, title: conv.title });
    });
  }
  if (req.method === 'GET' && p === '/api/conversations') {
    const all = listConvs();
    return sendJson(res, 200, role === 'owner' ? all : all.filter(c => String(c.id).startsWith('guest-')));
  }
  if (req.method === 'GET' && p.startsWith('/api/conversations/')) {
    const id = p.slice('/api/conversations/'.length);
    if (role !== 'owner' && !id.startsWith('guest-')) return ownerOnly();
    const conv = loadConv(id);
    return conv ? sendJson(res, 200, conv) : sendJson(res, 404, { error: 'not found' });
  }
  if (req.method === 'DELETE' && p.startsWith('/api/conversations/')) {
    const id = p.slice('/api/conversations/'.length);
    if (role !== 'owner' && !id.startsWith('guest-')) return ownerOnly();
    try { fs.unlinkSync(convPath(id)); } catch (_) {}
    for (const [sid, sess] of sessions.entries()) { if (sess.convId === id) sessions.delete(sid); }
    return sendJson(res, 200, { ok: true });
  }

  // Config
  if (req.method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, {
      model: CFG.model,
      workdir: role === 'owner' ? CFG.workdir : undefined,
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'],
      effort: role === 'owner' ? readEffort() : undefined,
      role,
    });
  }
  if (req.method === 'POST' && p === '/api/config') {
    if (role !== 'owner') return ownerOnly();
    return readBody(req, (body) => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
      if (data.model) CFG.model = data.model;
      if (data.effort && EFFORT_LEVELS.includes(data.effort)) {
        try { writeEffort(data.effort); } catch (_) {}
      }
      try {
        const saved = {};
        try { Object.assign(saved, JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8'))); } catch (_) {}
        if (data.model) saved.model = data.model;
        if (data.workdir) { saved.workdir = data.workdir; CFG.workdir = data.workdir; }
        fs.writeFileSync(HUB_CONFIG_FILE, JSON.stringify(saved, null, 2));
      } catch (_) {}
      sendJson(res, 200, { ok: true, model: CFG.model });
    });
  }

  // Connectors — touch ~/.claude.json, strictly owner-only
  if (p.startsWith('/api/connectors') && role !== 'owner') return ownerOnly();
  if (req.method === 'GET' && p === '/api/connectors') {
    const cj = loadClaudeJson();
    return sendJson(res, 200, cj.mcpServers || {});
  }
  if (req.method === 'POST' && p === '/api/connectors') {
    return readBody(req, (body) => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
      if (!data.name || !data.config) return sendJson(res, 400, { error: 'name and config required' });
      const cj = loadClaudeJson();
      if (!cj.mcpServers) cj.mcpServers = {};
      cj.mcpServers[data.name] = data.config;
      saveClaudeJson(cj);
      sendJson(res, 200, { ok: true });
    });
  }
  if (req.method === 'DELETE' && p.startsWith('/api/connectors/')) {
    const name = decodeURIComponent(p.slice('/api/connectors/'.length));
    const cj = loadClaudeJson();
    if (cj.mcpServers) delete cj.mcpServers[name];
    saveClaudeJson(cj);
    return sendJson(res, 200, { ok: true });
  }

  // Workflows — guests may list/run but not create or delete
  if (req.method === 'GET' && p === '/api/workflows') return sendJson(res, 200, loadWorkflows());
  if (p.startsWith('/api/workflows') && req.method !== 'GET' && role !== 'owner') return ownerOnly();
  if (req.method === 'POST' && p === '/api/workflows') {
    return readBody(req, (body) => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
      if (!data.name || !data.prompt) return sendJson(res, 400, { error: 'name and prompt required' });
      const wf = loadWorkflows();
      const entry = { id: crypto.randomUUID(), name: data.name, prompt: data.prompt, description: data.description || '', schedule: data.schedule || null, createdAt: new Date().toISOString() };
      wf.push(entry);
      saveWorkflows(wf);
      sendJson(res, 200, entry);
    });
  }
  if (req.method === 'DELETE' && p.startsWith('/api/workflows/')) {
    const id = p.slice('/api/workflows/'.length);
    saveWorkflows(loadWorkflows().filter(w => w.id !== id));
    return sendJson(res, 200, { ok: true });
  }

  // Projects — expose local paths and switch workdir, owner-only
  if (p.startsWith('/api/projects') && role !== 'owner') return ownerOnly();
  if (req.method === 'GET' && p === '/api/projects') return sendJson(res, 200, loadProjects());
  if (req.method === 'POST' && p === '/api/projects') {
    return readBody(req, (body) => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
      if (!data.name || !data.workdir) return sendJson(res, 400, { error: 'name and workdir required' });
      if (data.template && !fs.existsSync(data.workdir)) {
        try { scaffoldProject(data.workdir, data.template, data.name); }
        catch (e) { return sendJson(res, 500, { error: 'scaffold failed: ' + String(e.message).slice(0, 200) }); }
      }
      const projects = loadProjects();
      const entry = { id: crypto.randomUUID(), name: data.name, workdir: data.workdir, description: data.description || '', active: false };
      projects.push(entry);
      saveProjects(projects);
      sendJson(res, 200, entry);
    });
  }
  if (req.method === 'DELETE' && p.startsWith('/api/projects/') && !p.endsWith('/activate')) {
    const id = p.slice('/api/projects/'.length);
    if (id === 'default') return sendJson(res, 400, { error: 'cannot delete default project' });
    const projects = loadProjects();
    const target = projects.find(pr => pr.id === id);
    if (target) addHiddenProject(target.workdir); // keep auto-discovery from resurrecting it
    saveProjects(projects.filter(pr => pr.id !== id));
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p.startsWith('/api/projects/') && p.endsWith('/activate')) {
    const id = p.slice('/api/projects/'.length).replace('/activate', '');
    const projects = loadProjects().map(pr => ({ ...pr, active: pr.id === id }));
    saveProjects(projects);
    const active = projects.find(pr => pr.id === id);
    if (active) {
      CFG.workdir = active.workdir;
      try {
        const saved = {};
        try { Object.assign(saved, JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8'))); } catch (_) {}
        saved.workdir = active.workdir;
        fs.writeFileSync(HUB_CONFIG_FILE, JSON.stringify(saved, null, 2));
      } catch (_) {}
    }
    return sendJson(res, 200, { ok: true, workdir: active ? active.workdir : null });
  }

  // Open desktop apps on the host (VS Code / terminal / Explorer) — owner only
  if (req.method === 'POST' && p === '/api/open') {
    if (role !== 'owner') return ownerOnly();
    return readBody(req, (body) => {
      let app = '', dir = '', targetDevice = '';
      try { const d = JSON.parse(body); app = (d.app || '').toString(); dir = (d.workdir || CFG.workdir).toString(); targetDevice = (d.targetDevice || '').toString(); }
      catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
      const done = (err) => sendJson(res, 200, { ok: !err, error: err ? String(err.message).slice(0, 200) : undefined });

      // VS Code into a PEER device via Remote-SSH. The path lives on the target,
      // so we only sanity-check its shape (no local existsSync). Runs on THIS
      // node, so desktop VS Code opens on the device the user is touching.
      if (app === 'vscode' && targetDevice && !isSelfDevice(targetDevice)) {
        const t = resolveSshTarget(targetDevice);
        if (!t) return sendJson(res, 404, { error: 'unknown device' });
        if (!/^[A-Za-z]:[\\/][^"<>|&^%;\r\n]*$/.test(dir)) return sendJson(res, 400, { error: 'invalid workdir' });
        const remote = `${t.username}@${t.host}:${t.port}`;
        return exec(`code --remote ssh-remote+${remote} "${dir}"`, { windowsHide: true, timeout: 20000 }, done);
      }

      // Everything else opens locally — the path must exist on this machine.
      if (!/^[A-Za-z]:[\\/][^"<>|&^%;\r\n]*$/.test(dir) || !fs.existsSync(dir)) {
        return sendJson(res, 400, { error: 'invalid workdir' });
      }
      if (app === 'vscode') return exec(`code "${dir}"`, { windowsHide: true, timeout: 15000 }, done);
      // Explorer exits non-zero even on success — always report ok
      if (app === 'explorer') return exec(`explorer "${dir}"`, { windowsHide: true, timeout: 15000 }, () => sendJson(res, 200, { ok: true }));
      if (app === 'terminal') {
        return exec(`wt -d "${dir}"`, { windowsHide: true, timeout: 15000 }, (err) => {
          if (!err) return sendJson(res, 200, { ok: true, app: 'windows-terminal' });
          exec(`start "Server Hub" cmd /K "cd /d ${dir}"`, { windowsHide: false, timeout: 15000 },
            (e2) => sendJson(res, 200, { ok: !e2, app: 'cmd', error: e2 ? String(e2.message).slice(0, 200) : undefined }));
        });
      }
      sendJson(res, 400, { error: 'unknown app' });
    });
  }

  // WhatsApp daemon bridge — owner-only, strict whitelist of daemon endpoints
  const waProxy = WA_PROXY_ROUTES[req.method + ' ' + p];
  if (waProxy) {
    if (role !== 'owner') return ownerOnly();
    if (req.method === 'GET') return proxyWA('GET', waProxy, null, res);
    return readBody(req, (body) => proxyWA('POST', waProxy, body, res));
  }

  sendJson(res, 404, { error: 'not found' });
});

const WA_PORT = parseInt(process.env.WA_CONTROL_PORT || '8091', 10);
// Fire-and-forget DM to the owner's WhatsApp (Saved Messages) via the local WA
// daemon — used to ping you when a hub task finishes. No-op if WA isn't running.
function notifyOwnerWA(message) {
  try {
    const data = JSON.stringify({ message: String(message || '').slice(0, 4000) });
    const r = http.request({ hostname: '127.0.0.1', port: WA_PORT, path: '/notify-owner', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } });
    r.on('error', () => {});
    r.setTimeout(4000, () => { try { r.destroy(); } catch (_) {} });
    r.write(data); r.end();
  } catch (_) {}
}
const WA_PROXY_ROUTES = {
  'GET /api/wa/approvals': '/approvals',
  'POST /api/wa/approvals/resolve': '/approvals/resolve',
  'GET /api/wa/jobs': '/jobs',
  'POST /api/wa/jobs/cancel': '/jobs/cancel',
  'GET /api/wa/override': '/override',
  'POST /api/wa/override/revoke': '/override/revoke',
};
function proxyWA(method, waPath, body, res) {
  const r2 = http.request({
    hostname: '127.0.0.1', port: WA_PORT, path: waPath, method,
    headers: { 'Content-Type': 'application/json' },
  }, (r) => {
    let d = '';
    r.on('data', c => { d += c; });
    r.on('end', () => {
      try { sendJson(res, r.statusCode || 200, JSON.parse(d)); }
      catch (_) { sendJson(res, 502, { error: 'bad daemon response' }); }
    });
  });
  r2.on('error', () => sendJson(res, 502, { error: 'WhatsApp daemon offline' }));
  r2.setTimeout(8000, () => { r2.destroy(); sendJson(res, 504, { error: 'daemon timeout' }); });
  if (body) r2.write(body);
  r2.end();
}

// ---------- in-browser terminal: websocket <-> ssh2 bridge ----------
// The browser renders xterm.js and connects to /api/term?device=<id>&cwd=<path>.
// THIS node (the one the browser is talking to) opens an SSH session straight
// into the selected target — so the console "opens on the device interacting
// with the WebUI", SSH'd into the target. Works from laptops, tablets, phones.
function resolveSshTarget(deviceId) {
  if (isSelfDevice(deviceId)) {
    return { host: '127.0.0.1', port: 22, username: os.userInfo().username, label: 'this device' };
  }
  const dev = findDevice(deviceId);
  if (!dev || !dev.host) return null;
  return { host: dev.host, port: dev.sshPort || 22, username: dev.sshUser || os.userInfo().username, label: dev.name };
}

function setupTerminalBridge() {
  if (!WebSocketServer || !SSHClient) return;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch (_) { return socket.destroy(); }
    if (url.pathname !== '/api/term') return; // leave other upgrades alone
    // Owner-only: reuse the cookie auth used by the rest of the API.
    if (isAuthed(req) !== 'owner') { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => bridgeTerminal(ws, url));
  });
}

function bridgeTerminal(ws, url) {
  const target = resolveSshTarget(url.searchParams.get('device'));
  const cwd = (url.searchParams.get('cwd') || '').trim();
  if (!target) { try { ws.send('\r\n\x1b[31mUnknown device.\x1b[0m\r\n'); ws.close(); } catch (_) {} return; }

  let privateKey;
  try { privateKey = fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_ed25519')); }
  catch (_) { try { ws.send('\r\n\x1b[31mNo SSH key on this node (~/.ssh/id_ed25519). Run scripts/phase2-ssh-keys.ps1.\x1b[0m\r\n'); ws.close(); } catch (_) {} return; }

  const conn = new SSHClient();
  let stream = null;
  let cols = 80, rows = 24;

  ws.on('message', (data, isBinary) => {
    if (isBinary) { if (stream) stream.write(data); return; }
    // Text frames are JSON control messages (resize).
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'resize' && msg.cols && msg.rows) {
        cols = msg.cols; rows = msg.rows;
        if (stream) stream.setWindow(rows, cols, 0, 0);
      }
    } catch (_) {}
  });

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, s) => {
      if (err) { try { ws.send('\r\n\x1b[31mShell error: ' + err.message + '\x1b[0m\r\n'); ws.close(); } catch (_) {} return; }
      stream = s;
      if (cwd && /^[A-Za-z]:[\\/]/.test(cwd)) s.write('Set-Location -LiteralPath "' + cwd.replace(/"/g, '') + '"\r');
      s.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
      s.on('close', () => { try { ws.close(); } catch (_) {} conn.end(); });
    });
  });
  conn.on('error', (e) => { try { ws.send('\r\n\x1b[31mSSH error (' + target.label + '): ' + e.message + '\x1b[0m\r\n'); ws.close(); } catch (_) {} });
  ws.on('close', () => { try { if (stream) stream.end(); } catch (_) {} try { conn.end(); } catch (_) {} });

  try { ws.send('\r\n\x1b[2mConnecting to ' + target.label + ' (' + target.username + '@' + target.host + ')…\x1b[0m\r\n'); } catch (_) {}
  conn.connect({ host: target.host, port: target.port, username: target.username, privateKey, readyTimeout: 12000, keepaliveInterval: 20000 });
}

setupTerminalBridge();

server.listen(CFG.port, CFG.bind, () => {
  console.log(`server-hub Web UI listening on http://${CFG.bind}:${CFG.port}`);
  console.log(`  model=${CFG.model}  workdir=${CFG.workdir}  permission=${CFG.permissionMode}`);
  const tsIp = (() => {
    const os = require('os');
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces) { if (i.family === 'IPv4' && i.address.startsWith('100.')) return i.address; }
    }
    return '<tailscale-ip>';
  })();
  console.log(`  Open over Tailscale:  http://${tsIp}:${CFG.port}`);
});

// ---------- handlers ----------
const DIST_DIR = path.join(__dirname, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json', '.woff2': 'font/woff2',
};
function serveFile(res, file, ext) {
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}
function serveDist(res, p) {
  const f = path.normalize(path.join(DIST_DIR, p));
  if (!f.startsWith(DIST_DIR)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(f, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(buf);
  });
}
// Serve the built React app (webui/dist) when present; legacy UI stays at /legacy.
function serveIndex(res) {
  const distIndex = path.join(DIST_DIR, 'index.html');
  serveFile(res, fs.existsSync(distIndex) ? distIndex : path.join(__dirname, 'public', 'index.html'), '.html');
}

function handleLogin(req, res) {
  readBody(req, (body) => {
    let pass = '';
    try { pass = JSON.parse(body).password || ''; } catch (_) {}
    let role = null;
    if (pass === CFG.password) role = 'owner';
    else if (CFG.guestPassword && pass === CFG.guestPassword) role = 'guest';
    if (!role) return sendJson(res, 401, { error: 'wrong password' });
    const token = issueToken(role);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `hub_auth=${token}; HttpOnly; SameSite=Strict${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}; Path=/; Max-Age=2592000`,
    });
    res.end(JSON.stringify({ ok: true, role }));
  });
}

function handleChat(req, res, role) {
  readBody(req, (body) => {
    let message = '', sessionId = '', modelOverride = '', convId = '', ephemeral = false;
    let systemPrompt = '', reqPermissionMode = '', reqTimeoutMs = 0;
    try {
      const parsed = JSON.parse(body);
      message = (parsed.message || '').toString();
      sessionId = (parsed.sessionId || '').toString();
      modelOverride = (parsed.model || '').toString();
      convId = (parsed.convId || '').toString();
      ephemeral = parsed.ephemeral === true;
      const params = parsed.params || {};
      systemPrompt = (params.systemPrompt || '').toString().trim();
      reqPermissionMode = (params.permissionMode || '').toString().trim();
      reqTimeoutMs = parseInt(params.turnTimeoutSec || '0', 10) * 1000;
    } catch (_) {
      return sendJson(res, 400, { error: 'bad json' });
    }
    if (!message.trim()) return sendJson(res, 400, { error: 'empty message' });

    const model = modelOverride || CFG.model;

    let sess, conv = null;
    if (ephemeral) {
      // /btw side question: one-shot Claude session, nothing persisted,
      // current conversation context untouched.
      sessionId = crypto.randomUUID();
      convId = '';
      sess = { claudeSessionId: sessionId, started: false, convId: '' };
    } else {
      if (role === 'guest' && convId && !convId.startsWith('guest-')) convId = '';
      if (!sessionId || !sessions.has(sessionId)) {
        sessionId = crypto.randomUUID();
        if (!convId) convId = (role === 'guest' ? 'guest-' : '') + sessionId;
        sessions.set(sessionId, { claudeSessionId: sessionId, started: false, convId });
      }
      sess = sessions.get(sessionId);
      if (!sess.convId && convId) sess.convId = convId;
      convId = sess.convId || convId || sessionId;
      if (role === 'guest' && !String(convId).startsWith('guest-')) convId = 'guest-' + convId;
      sess.convId = convId;

      conv = loadConv(convId);
      if (!conv) conv = createConv(convId, model, CFG.workdir);

      conv.messages.push({ role: 'user', text: message, ts: Date.now() });
      if (!conv.title) conv.title = message.slice(0, 60);
      saveConv(conv);
    }

    // When the Claude session is fresh but the conversation has history (server
    // restarted, conversation reopened, or message edited), replay a transcript
    // so Claude keeps continuity.
    let outboundText = message;
    if (!ephemeral && !sess.started && conv.messages.length > 1) {
      const hist = conv.messages.slice(0, -1);
      let t = hist.map(m => (m.role === 'user' ? 'User' : 'Assistant') + ': ' + m.text).join('\n\n');
      if (t.length > 8000) t = '…' + t.slice(-8000);
      outboundText =
        '<conversation-history>\nEarlier messages of this conversation (the session was restarted — continue seamlessly and do not mention this block):\n' +
        t + '\n</conversation-history>\n\n' + message;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Session-Id': sessionId,
      'X-Conv-Id': convId,
    });
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');

    const sessionFlag = sess.started
      ? ['--resume', sess.claudeSessionId]
      : ['--session-id', sess.claudeSessionId];

    // Guests get a tool-stripped Claude: no shell, no filesystem, no MCP, auto-deny prompts.
    const permMode = role === 'guest' ? 'default' : (reqPermissionMode || CFG.permissionMode);
    const turnTimeout = reqTimeoutMs > 0 ? reqTimeoutMs : CFG.turnTimeoutMs;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model', model,
      '--permission-mode', permMode,
      ...sessionFlag,
    ];
    if (role === 'guest') args.push('--disallowedTools', GUEST_DISALLOWED_TOOLS);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);

    // Each conversation runs in the folder it was created in, so switching the
    // active project never changes where an existing chat operates.
    const convCwd = (conv && conv.workdir && fs.existsSync(conv.workdir)) ? conv.workdir : CFG.workdir;
    const child = spawn(CLAUDE.command, [...CLAUDE.prefix, ...args], {
      cwd: convCwd,
      shell: CLAUDE.shell,
      windowsHide: true,
    });
    sess.started = true;
    sess.model = model;

    const killTimer = setTimeout(() => {
      send({ type: 'error', message: 'turn timed out' });
      try { child.kill(); } catch (_) {}
    }, turnTimeout);

    const userMsg = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: outboundText }] },
    };
    child.stdin.write(JSON.stringify(userMsg) + '\n');
    child.stdin.end();

    let buf = '', fullAssistantText = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          const textChunk = routeClaudeEvent(line, send, sess);
          if (textChunk) fullAssistantText += textChunk;
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      if (process.env.HUB_DEBUG) fs.appendFileSync(path.join(__dirname, '_debug.log'), '[SPAWN ERROR] ' + err.message + '\n');
      send({ type: 'error', message: 'spawn failed: ' + err.message });
      res.end();
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (process.env.HUB_DEBUG) fs.appendFileSync(path.join(__dirname, '_debug.log'), '[CLOSE] code=' + code + ' stderrLen=' + stderr.length + '\n');
      if (code !== 0 && stderr) send({ type: 'error', message: stderr.slice(0, 500) });

      if (!ephemeral && fullAssistantText) {
        conv.messages.push({ role: 'assistant', text: fullAssistantText, ts: Date.now() });
        saveConv(conv);
      }

      send({ type: 'done', sessionId, convId });
      res.end();
    });

    res.on('close', () => {
      if (!res.writableEnded) { try { child.kill(); } catch (_) {} }
    });
  });
}

function handleWAStatus(res) {
  const req2 = http.request({ hostname: '127.0.0.1', port: 8091, path: '/status', method: 'GET' }, (r) => {
    let data = '';
    r.on('data', c => { data += c; });
    r.on('end', () => {
      try { sendJson(res, 200, JSON.parse(data)); }
      catch (_) { sendJson(res, 200, { ready: false, needsQR: false, status: 'unknown' }); }
    });
  });
  req2.on('error', () => sendJson(res, 200, { ready: false, needsQR: false, status: 'offline' }));
  req2.setTimeout(3000, () => { req2.destroy(); sendJson(res, 200, { ready: false, needsQR: false, status: 'timeout' }); });
  req2.end();
}

// Returns the text chunk (for accumulation) or null.
function routeClaudeEvent(line, send, sess) {
  let ev;
  try { ev = JSON.parse(line); } catch (_) { return null; }

  if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
    sess.claudeSessionId = ev.session_id;
    return null;
  }

  if (ev.type === 'stream_event' && ev.event) {
    const e = ev.event;
    if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
      send({ type: 'text', text: e.delta.text });
      return e.delta.text;
    } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'input_json_delta') {
      if (typeof sess._toolBuf === 'string' && sess._toolBuf.length < 4000) sess._toolBuf += e.delta.partial_json || '';
    } else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
      send({ type: 'tool', name: e.content_block.name || 'tool' });
      sess._toolBuf = '';
    } else if (e.type === 'content_block_stop' && typeof sess._toolBuf === 'string') {
      if (sess._toolBuf) send({ type: 'tool_input', input: sess._toolBuf.slice(0, 4000) });
      sess._toolBuf = null;
    }
    return null;
  }

  if (ev.type === 'result') {
    if (ev.session_id) sess.claudeSessionId = ev.session_id;
    if (ev.is_error && ev.result) send({ type: 'error', message: String(ev.result) });
    if (ev.usage) { send({ type: 'usage', usage: ev.usage }); logUsage(sess.model, ev.usage); }
    return null;
  }

  return null;
}

// Owner-only system commands for the web UI slash commands.
// Strict whitelist: pm2 actions on validated process names, fixed git read commands.
function handleCommand(req, res) {
  readBody(req, (body) => {
    let d = {};
    try { d = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    const name = (d.name || '').toString();
    if (name && !/^[\w.-]{1,64}$/.test(name)) return sendJson(res, 400, { error: 'invalid process name' });

    let cmd = null;
    if (d.cmd === 'pm2-list') {
      // jlist output is huge (full env per process) — slim it down server-side
      return exec('pm2 jlist', { windowsHide: true, timeout: 15000, maxBuffer: 4e6 }, (err, stdout) => {
        let list = [];
        try {
          list = JSON.parse(stdout).map(pr => ({
            name: pr.name,
            status: (pr.pm2_env && pr.pm2_env.status) || '?',
            cpu: pr.monit ? pr.monit.cpu : null,
            memory: pr.monit ? pr.monit.memory : null,
            restarts: pr.pm2_env ? pr.pm2_env.restart_time : null,
          }));
        } catch (_) {}
        sendJson(res, 200, { ok: !err, list });
      });
    } else if (d.cmd === 'pm2-action') {
      if (!['restart', 'stop', 'start'].includes(d.action)) return sendJson(res, 400, { error: 'invalid action' });
      if (!name) return sendJson(res, 400, { error: 'process name required' });
      cmd = `pm2 ${d.action} ${name}`;
    } else if (d.cmd === 'logs') {
      if (!name) return sendJson(res, 400, { error: 'process name required' });
      const lines = Math.min(Math.max(parseInt(d.lines || '30', 10) || 30, 1), 200);
      cmd = `pm2 logs ${name} --lines ${lines} --nostream`;
    } else if (d.cmd === 'git') {
      const gitCmds = {
        branch: 'git branch -a --no-color',
        status: 'git status --short --branch',
        log: 'git log --oneline --no-color -10',
      };
      cmd = gitCmds[d.action];
      if (!cmd) return sendJson(res, 400, { error: 'invalid git action' });
    } else {
      return sendJson(res, 400, { error: 'unknown command' });
    }

    exec(cmd, { cwd: CFG.workdir, windowsHide: true, timeout: 20000, maxBuffer: 1e6 }, (err, stdout, stderr) => {
      sendJson(res, 200, {
        ok: !err,
        output: ((stdout || '') + (stderr ? '\n' + stderr : '')).trim().slice(0, 12000),
        error: err ? String(err.message).slice(0, 300) : undefined,
      });
    });
  });
}

function handleGetParams(res) {
  try {
    sendJson(res, 200, JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')));
  } catch (_) {
    sendJson(res, 200, { systemPrompt: '', permissionMode: '', turnTimeoutSec: 600 });
  }
}

function handlePostParams(req, res) {
  readBody(req, (body) => {
    let data = {};
    try { data = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    try { fs.writeFileSync(PARAMS_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
    sendJson(res, 200, { ok: true });
  });
}

function handleDashboard(res) {
  const result = { tasks: {}, pm2: [], wa: { ready: false, status: 'unknown' } };

  try {
    result.tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).tasks || {};
  } catch (_) {}

  // Always-current fallback: surface currently-active Claude sessions (from the
  // live transcripts) so the card reflects real CLI/console activity even when
  // the user-level task hooks aren't in a session's snapshot.
  try {
    for (const s of listSessions()) {
      if (s.status !== 'active') continue;
      const key = 'session-' + s.sessionId;
      if (result.tasks[key]) continue;
      const label = s.lastPrompt || (s.cwd ? s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'console session');
      result.tasks[key] = { id: key, description: '🖥 ' + label, status: 'running', createdAt: s.startedAt, updatedAt: s.lastActivity };
    }
  } catch (_) {}

  const finalize = (pm2Out) => {
    try { result.pm2 = JSON.parse(pm2Out || '[]'); } catch (_) {}
    const waReq = http.request({ hostname: '127.0.0.1', port: 8091, path: '/status', method: 'GET' }, (r) => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => { try { result.wa = JSON.parse(d); } catch (_) {} sendJson(res, 200, result); });
    });
    waReq.on('error', () => sendJson(res, 200, result));
    waReq.setTimeout(3000, () => { waReq.destroy(); sendJson(res, 200, result); });
    waReq.end();
  };

  exec('pm2 jlist', { windowsHide: true, timeout: 5000 }, (err, stdout) => finalize(stdout));
}

// ---------- project templates ----------
const TEMPLATES = {
  node: (name) => ({
    'package.json': JSON.stringify({ name: slug(name), version: '0.1.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2),
    'index.js': "console.log('hello from " + name + "');\n",
    '.gitignore': 'node_modules/\n.env\n',
    'README.md': '# ' + name + '\n',
  }),
  python: (name) => ({
    'main.py': 'def main():\n    print("hello from ' + name + '")\n\nif __name__ == "__main__":\n    main()\n',
    'requirements.txt': '',
    '.gitignore': '__pycache__/\n.venv/\n.env\n',
    'README.md': '# ' + name + '\n',
  }),
  'vite-react': (name) => ({
    'package.json': JSON.stringify({
      name: slug(name), private: true, version: '0.1.0', type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { '@vitejs/plugin-react': '^4.3.4', vite: '^5.4.0' },
    }, null, 2),
    'vite.config.js': "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n",
    'index.html': '<!doctype html>\n<html>\n<head><meta charset="UTF-8"/><title>' + name + '</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n',
    'src/main.jsx': "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\ncreateRoot(document.getElementById('root')).render(<App />)\n",
    'src/App.jsx': "export default function App() {\n  return <h1>" + name + "</h1>\n}\n",
    '.gitignore': 'node_modules/\ndist/\n.env\n',
    'README.md': '# ' + name + '\n\nRun `npm install` then `npm run dev`.\n',
  }),
  empty: (name) => ({ 'README.md': '# ' + name + '\n' }),
};
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'; }
function scaffoldProject(workdir, template, name) {
  const files = (TEMPLATES[template] || TEMPLATES.empty)(name);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
  exec('git init', { cwd: workdir, windowsHide: true, timeout: 10000 }, () => {});
}

// ---------- files API (rooted at the active project workdir) ----------
const UPLOADS_DIR = path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}

function safeWorkdirPath(rel) {
  const base = path.normalize(CFG.workdir);
  const f = path.normalize(path.join(base, rel || ''));
  return (f === base || f.startsWith(base + path.sep)) ? f : null;
}

function handleFilesList(url, res) {
  const dir = safeWorkdirPath(url.searchParams.get('dir') || '');
  if (!dir) return sendJson(res, 400, { error: 'bad path' });
  fs.readdir(dir, { withFileTypes: true }, (err, ents) => {
    if (err) return sendJson(res, 200, { error: String(err.message), entries: [] });
    const entries = ents.map((e) => {
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch (_) {}
      return { name: e.name, dir: e.isDirectory(), size, mtime };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    sendJson(res, 200, { root: CFG.workdir, entries });
  });
}

const TEXT_EXTS = /\.(txt|md|js|jsx|ts|tsx|json|css|html|htm|xml|yml|yaml|toml|ini|env|py|rb|go|rs|java|c|h|cpp|cs|sh|ps1|bat|cmd|sql|csv|log|gitignore|svg|vue|svelte|lock|cfg|conf|example)$/i;
function handleFileRead(url, res) {
  const f = safeWorkdirPath(url.searchParams.get('path') || '');
  if (!f) return sendJson(res, 400, { error: 'bad path' });
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(f).toLowerCase();
    const image = /\.(png|jpe?g|gif|webp|ico|bmp|svg)$/i.test(f);
    const text = TEXT_EXTS.test(f) || path.basename(f).startsWith('.');
    if (!text || st.size > 512000) return sendJson(res, 200, { binary: !text, tooBig: st.size > 512000, image, size: st.size, ext });
    fs.readFile(f, 'utf8', (e2, content) => {
      if (e2) return sendJson(res, 500, { error: String(e2.message) });
      sendJson(res, 200, { content, size: st.size, image, ext });
    });
  });
}

function handleFileRaw(url, res) {
  const f = safeWorkdirPath(url.searchParams.get('path') || '');
  if (!f) return sendJson(res, 400, { error: 'bad path' });
  const m = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf' };
  fs.readFile(f, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': m[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Content-Disposition': 'inline; filename="' + path.basename(f).replace(/"/g, '') + '"' });
    res.end(buf);
  });
}

// Chat attachments + file-browser uploads. Bigger body cap than readBody.
function handleUpload(req, res) {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 22e6) req.destroy(); });
  req.on('end', () => {
    let name = '', b64 = '', dir = '';
    try { const d = JSON.parse(data); name = (d.name || 'file').toString(); b64 = (d.dataBase64 || '').toString(); dir = (d.dir || '').toString(); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    name = name.replace(/[^\w.\- ()\[\]]/g, '_').slice(0, 120) || 'file';
    let target;
    if (dir === '__workdir__' || dir.startsWith('rel:')) {
      const sub = dir.startsWith('rel:') ? dir.slice(4) : '';
      const d2 = safeWorkdirPath(sub);
      if (!d2) return sendJson(res, 400, { error: 'bad dir' });
      target = path.join(d2, name);
    } else {
      target = path.join(UPLOADS_DIR, Date.now() + '-' + name);
    }
    try {
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
      sendJson(res, 200, { ok: true, path: target, name });
    } catch (e) { sendJson(res, 500, { error: String(e.message) }); }
  });
}

// ---------- git + GitHub (active project workdir) ----------
function run(cmd, args, cb, opts = {}) {
  // 'error' and 'close' can both fire (e.g. spawn ENOENT) — invoke cb exactly once.
  let called = false;
  const once = (err, o, e) => { if (!called) { called = true; cb(err, o, e); } };
  let ch;
  try { ch = spawn(cmd, args, { cwd: CFG.workdir, windowsHide: true, ...opts }); }
  catch (e) { return once(e, '', ''); }
  let out = '', errOut = '';
  ch.stdout.on('data', (c) => { out += c; });
  ch.stderr.on('data', (c) => { errOut += c; });
  ch.on('error', (e) => once(e, out, errOut));
  ch.on('close', (code) => once(code ? new Error((errOut || out || 'exit ' + code).slice(0, 400)) : null, out, errOut));
}

// Parse `git status --porcelain` (XY filename) into structured entries the
// VS Code-style Source Control panel can group into staged / changes / untracked.
function parsePorcelain(st) {
  return (st || '').split('\n').filter(Boolean).map((l) => {
    const x = l[0], y = l[1];
    let file = l.slice(3), renamedFrom = null;
    if (file.includes(' -> ')) { const [from, to] = file.split(' -> '); renamedFrom = from; file = to; }
    const untracked = x === '?' && y === '?';
    // Unmerged (conflict) states: UU/AA/DD or any side marked U.
    const conflicted = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    return {
      x, y,
      status: (x + y).trim() || '??',
      file, renamedFrom, conflicted,
      staged: !conflicted && !untracked && x !== ' ' && x !== '?',
      unstaged: !conflicted && (untracked || (y !== ' ' && y !== '?')),
      untracked: !conflicted && untracked,
    };
  });
}

function handleGitStatus(res) {
  run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], (err, branch) => {
    if (err) return sendJson(res, 200, { ok: false, error: 'not a git repo (' + CFG.workdir + ')' });
    run('git', ['status', '--porcelain'], (e2, st) => {
      run('git', ['log', '-12', '--pretty=format:%h%x09%ar%x09%s'], (e3, log) => {
        run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], (e4, upstream) => {
          const finish = (ahead, behind) => {
            const files = parsePorcelain(st);
            const commits = (log || '').split('\n').filter(Boolean).map((l) => { const [h, when, ...s] = l.split('\t'); return { hash: h, when, subject: s.join('\t') }; });
            // Detect an in-progress merge/rebase so the UI can offer Abort.
            let state = null;
            try {
              const gd = path.join(CFG.workdir, '.git');
              if (fs.existsSync(path.join(gd, 'MERGE_HEAD'))) state = 'merging';
              else if (fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))) state = 'rebasing';
            } catch (_) {}
            sendJson(res, 200, {
              ok: true,
              branch: branch.trim(),
              upstream: e4 ? null : upstream.trim(),
              ahead, behind, state,
              files,
              staged: files.filter((f) => f.staged),
              unstaged: files.filter((f) => f.unstaged && !f.untracked),
              untracked: files.filter((f) => f.untracked),
              conflicts: files.filter((f) => f.conflicted),
              commits,
              workdir: CFG.workdir,
            });
          };
          if (e4) return finish(0, 0);
          // left=upstream-only (behind), right=HEAD-only (ahead)
          run('git', ['rev-list', '--left-right', '--count', upstream.trim() + '...HEAD'], (e5, counts) => {
            const m = (counts || '').trim().split(/\s+/);
            finish(parseInt(m[1] || '0', 10) || 0, parseInt(m[0] || '0', 10) || 0);
          });
        });
      });
    });
  });
}

function handleGitDiff(url, res) {
  const file = url.searchParams.get('file') || '';
  const staged = url.searchParams.get('staged') === '1';
  const commit = url.searchParams.get('commit') || '';
  if (file && !safeWorkdirPath(file)) return sendJson(res, 400, { error: 'bad path' });

  if (commit) {
    if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) return sendJson(res, 400, { error: 'bad commit' });
    const args = ['show', '--no-color', commit];
    if (file) args.push('--', file);
    return run('git', args, (err, out) => sendJson(res, 200, err ? { ok: false, error: String(err.message) } : { ok: true, diff: (out || '').slice(0, 80000) }));
  }

  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  if (file) args.push('--', file);
  run('git', args, (err, out) => {
    if (err) return sendJson(res, 200, { ok: false, error: String(err.message) });
    if (out.trim() || !file || staged) return sendJson(res, 200, { ok: true, diff: out.slice(0, 80000) });
    // unstaged diff empty for this file — try the staged diff, else show raw (new/untracked) content
    run('git', ['diff', '--no-color', '--cached', '--', file], (e2, st) => {
      if (st && st.trim()) return sendJson(res, 200, { ok: true, diff: st.slice(0, 80000) });
      fs.readFile(path.join(CFG.workdir, file), 'utf8', (e3, content) => {
        sendJson(res, 200, { ok: true, diff: e3 ? '(no diff)' : '(new file)\n' + content.slice(0, 80000) });
      });
    });
  });
}

// Validate a repo-relative file list stays inside the workdir (no ../ escape).
// Returns the (unchanged) list, or null if anything is out of bounds / malformed.
function safeRelFiles(files) {
  if (!Array.isArray(files)) return null;
  const out = [];
  for (const f of files) {
    if (typeof f !== 'string' || !f || !safeWorkdirPath(f)) return null;
    out.push(f);
  }
  return out;
}

// Shared responder for one-shot git mutations.
function gitSimple(res, args, okExtra = {}) {
  run('git', args, (err, out, errOut) => sendJson(res, 200, err
    ? { ok: false, error: String(errOut || err.message).slice(0, 400) }
    : { ok: true, out: ((out || '') + (errOut || '')).slice(0, 2000), ...okExtra }));
}

function handleGitCommit(req, res) {
  readBody(req, (body) => {
    let message = '', all = false;
    try { const d = JSON.parse(body); message = (d.message || '').toString().trim(); all = d.all === true; } catch (_) {}
    if (!message) return sendJson(res, 400, { error: 'message required' });
    const doCommit = () => run('git', ['commit', '-m', message], (e2, out) => {
      if (e2) return sendJson(res, 200, { ok: false, error: String(e2.message).slice(0, 400) });
      sendJson(res, 200, { ok: true, out: out.slice(0, 400) });
    });
    // "Commit All" stages everything first; default commits only what's staged.
    if (all) return run('git', ['add', '-A'], (err) => err ? sendJson(res, 200, { ok: false, error: String(err.message) }) : doCommit());
    // `git diff --cached --quiet` exits non-zero when there ARE staged changes.
    run('git', ['diff', '--cached', '--quiet'], (err) => {
      if (!err) return sendJson(res, 200, { ok: false, error: 'nothing staged — stage files first (or use Commit All)' });
      doCommit();
    });
  });
}

function handleGitStage(req, res) {
  readBody(req, (body) => {
    let files; try { files = JSON.parse(body).files; } catch (_) {}
    if (files !== undefined) { const safe = safeRelFiles(files); if (!safe) return sendJson(res, 400, { error: 'bad path' }); return gitSimple(res, safe.length ? ['add', '--', ...safe] : ['add', '-A']); }
    gitSimple(res, ['add', '-A']);
  });
}

function handleGitUnstage(req, res) {
  readBody(req, (body) => {
    let files; try { files = JSON.parse(body).files; } catch (_) {}
    if (files !== undefined) { const safe = safeRelFiles(files); if (!safe) return sendJson(res, 400, { error: 'bad path' }); return gitSimple(res, safe.length ? ['restore', '--staged', '--', ...safe] : ['reset']); }
    gitSimple(res, ['reset']);
  });
}

function handleGitDiscard(req, res) {
  readBody(req, (body) => {
    let files, untracked = false; try { const d = JSON.parse(body); files = d.files; untracked = d.untracked === true; } catch (_) {}
    const safe = safeRelFiles(files);
    if (!safe || !safe.length) return sendJson(res, 400, { error: 'files required' });
    gitSimple(res, untracked ? ['clean', '-fd', '--', ...safe] : ['checkout', '--', ...safe]);
  });
}

function handleGitFetch(res) { gitSimple(res, ['fetch', '--all', '--prune']); }
function handleGitPull(res) { gitSimple(res, ['pull', '--ff-only']); }

function handleGitPush(req, res) {
  // Push to the existing upstream, or set one against origin/<branch> on first push.
  run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], (e) => {
    if (!e) return gitSimple(res, ['push']);
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], (e2, br) => {
      if (e2) return sendJson(res, 200, { ok: false, error: 'no current branch' });
      gitSimple(res, ['push', '-u', 'origin', br.trim()]);
    });
  });
}

function handleGitBranches(res) {
  run('git', ['branch', '-a', '--no-color', '--format=%(refname)%09%(HEAD)%09%(upstream:short)'], (err, out) => {
    if (err) return sendJson(res, 200, { ok: false, error: String(err.message) });
    const branches = [];
    for (const l of (out || '').split('\n').filter(Boolean)) {
      const [ref, head, upstream] = l.split('\t');
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice(11), current: head === '*', remote: false, upstream: upstream || null });
      else if (ref.startsWith('refs/remotes/')) {
        const name = ref.slice(13);
        if (name.endsWith('/HEAD')) continue; // skip the remote's symbolic HEAD ref
        branches.push({ name, current: false, remote: true, upstream: null });
      }
    }
    sendJson(res, 200, { ok: true, branches });
  });
}

function handleGitBranch(req, res) {
  readBody(req, (body) => {
    let name = '', from = '', checkout = false;
    try { const d = JSON.parse(body); name = (d.name || '').toString().trim(); from = (d.from || '').toString().trim(); checkout = d.checkout === true; } catch (_) {}
    if (!/^[\w./-]{1,200}$/.test(name)) return sendJson(res, 400, { error: 'bad branch name' });
    if (checkout) return gitSimple(res, ['switch', name.replace(/^origin\//, '')]); // remote ref -> auto tracking branch
    const args = ['switch', '-c', name];
    if (from) { if (!/^[\w./-]{1,200}$/.test(from)) return sendJson(res, 400, { error: 'bad base' }); args.push(from); }
    gitSimple(res, args);
  });
}

function handleGitBranchDelete(req, res) {
  readBody(req, (body) => {
    let name = '', force = false;
    try { const d = JSON.parse(body); name = (d.name || '').toString().trim(); force = d.force === true; } catch (_) {}
    if (!/^[\w./-]{1,200}$/.test(name)) return sendJson(res, 400, { error: 'bad branch name' });
    gitSimple(res, ['branch', force ? '-D' : '-d', name]);
  });
}

function handleGitStash(req, res) {
  readBody(req, (body) => {
    let action = '', index = 0, message = '';
    try { const d = JSON.parse(body); action = (d.action || '').toString(); index = parseInt(d.index || '0', 10) || 0; message = (d.message || '').toString().slice(0, 200); } catch (_) {}
    if (action === 'list') {
      return run('git', ['stash', 'list'], (err, out) => {
        if (err) return sendJson(res, 200, { ok: false, error: String(err.message) });
        const stashes = (out || '').split('\n').filter(Boolean).map((l) => { const i = l.indexOf(':'); return { ref: l.slice(0, i), text: l.slice(i + 1).trim() }; });
        sendJson(res, 200, { ok: true, stashes });
      });
    }
    if (action === 'save') { const args = ['stash', 'push']; if (message) args.push('-m', message); return gitSimple(res, args); }
    if (['pop', 'apply', 'drop'].includes(action)) return gitSimple(res, ['stash', action, `stash@{${index}}`]);
    sendJson(res, 400, { error: 'bad action' });
  });
}

function handleGitMerge(req, res) {
  readBody(req, (body) => {
    let branch = '';
    try { branch = (JSON.parse(body).branch || '').toString().trim(); } catch (_) {}
    if (!/^[\w./-]{1,200}$/.test(branch)) return sendJson(res, 400, { error: 'bad branch' });
    gitSimple(res, ['merge', '--no-edit', branch]);
  });
}

// Resolve conflicts: take one side (ours/theirs) then stage, or just mark
// resolved (stage) after a manual edit.
function handleGitResolve(req, res) {
  readBody(req, (body) => {
    let d = {}; try { d = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    const files = safeRelFiles(d.files);
    if (!files || !files.length) return sendJson(res, 400, { error: 'files required' });
    if (d.side === 'ours' || d.side === 'theirs') {
      run('git', ['checkout', d.side === 'ours' ? '--ours' : '--theirs', '--', ...files], (err) => {
        if (err) return sendJson(res, 200, { ok: false, error: String(err.message).slice(0, 300) });
        gitSimple(res, ['add', '--', ...files]);
      });
    } else {
      gitSimple(res, ['add', '--', ...files]); // mark resolved as-is
    }
  });
}

// Abort an in-progress merge/rebase/cherry-pick.
function handleGitAbort(req, res) {
  readBody(req, (body) => {
    let op = 'merge'; try { op = (JSON.parse(body).op || 'merge').toString(); } catch (_) {}
    const cmd = op === 'rebase' ? ['rebase', '--abort'] : op === 'cherry-pick' ? ['cherry-pick', '--abort'] : ['merge', '--abort'];
    gitSimple(res, cmd);
  });
}

// Ask a fast model to draft a commit message from the current diff.
function handleGitAiMsg(res) {
  run('git', ['diff', '--no-color'], (err, diff) => {
    run('git', ['status', '--porcelain'], (e2, st) => {
      const input = ('Status:\n' + (st || '') + '\nDiff:\n' + (diff || '')).slice(0, 9000);
      if (!st && !diff) return sendJson(res, 200, { ok: false, error: 'nothing to commit' });
      const ch = spawn(CLAUDE.command, [...CLAUDE.prefix, '-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'text'], {
        cwd: CFG.workdir, shell: CLAUDE.shell, windowsHide: true,
      });
      let out = '';
      ch.stdout.on('data', (c) => { out += c; });
      const t = setTimeout(() => { try { ch.kill(); } catch (_) {} }, 60000);
      ch.on('error', () => { clearTimeout(t); sendJson(res, 200, { ok: false, error: 'claude spawn failed' }); });
      ch.on('close', () => {
        clearTimeout(t);
        const msg = out.trim().split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').slice(0, 110);
        sendJson(res, 200, msg ? { ok: true, message: msg } : { ok: false, error: 'no suggestion' });
      });
      ch.stdin.write('Write a single-line conventional-commit message (max 90 chars, no quotes, no explanation) for these changes:\n\n' + input);
      ch.stdin.end();
    });
  });
}

const GH_EXE = (() => {
  const g = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  try { if (fs.existsSync(g)) return g; } catch (_) {}
  return 'gh';
})();
// gh supports multiple logged-in accounts per host; expose list + switch.
// `gh auth status` writes to stdout or stderr depending on version — parse both.
function handleGhAccounts(res) {
  run(GH_EXE, ['auth', 'status'], (err, out, errOut) => {
    const txt = (out || '') + '\n' + (errOut || '');
    const accounts = [];
    let cur = null;
    for (const l of txt.split(/\r?\n/)) {
      const m = /Logged in to ([\w.-]+) account ([^\s(]+)/.exec(l);
      if (m) { cur = { host: m[1], user: m[2], active: false }; accounts.push(cur); continue; }
      if (cur && /Active account:\s*true/i.test(l)) cur.active = true;
    }
    // single-account gh versions don't print "Active account" — mark the only one active
    if (accounts.length === 1 && !accounts[0].active) accounts[0].active = true;
    if (!accounts.length) return sendJson(res, 200, { ok: false, error: err ? String(err.message).slice(0, 200) : 'no gh accounts — run: gh auth login' });
    sendJson(res, 200, { ok: true, accounts });
  });
}

function handleGhSwitch(req, res) {
  readBody(req, (body) => {
    let user = '';
    try { user = (JSON.parse(body).user || '').toString(); } catch (_) {}
    if (!/^[\w-]{1,60}$/.test(user)) return sendJson(res, 400, { error: 'bad user' });
    run(GH_EXE, ['auth', 'switch', '--hostname', 'github.com', '--user', user], (err, out, errOut) => {
      ghCache = { at: 0, key: '', data: null };
      if (err) return sendJson(res, 200, { ok: false, error: String(errOut || err.message).slice(0, 200) });
      sendJson(res, 200, { ok: true, user });
    });
  });
}

let ghCache = { at: 0, key: '', data: null };
function handleGitHub(res) {
  if (ghCache.data && ghCache.key === CFG.workdir && Date.now() - ghCache.at < 120000) return sendJson(res, 200, ghCache.data);
  run(GH_EXE, ['pr', 'list', '--json', 'number,title,url,headRefName,isDraft', '-L', '8'], (err, prs) => {
    if (err) {
      const data = { ok: false, error: /not a git|no git remotes|could not determine/i.test(String(err.message)) ? 'no GitHub remote for this project' : String(err.message).slice(0, 160) };
      return sendJson(res, 200, data);
    }
    run(GH_EXE, ['issue', 'list', '--json', 'number,title,url', '-L', '8'], (e2, issues) => {
      let data;
      try { data = { ok: true, prs: JSON.parse(prs || '[]'), issues: e2 ? [] : JSON.parse(issues || '[]') }; }
      catch (_) { data = { ok: false, error: 'bad gh output' }; }
      ghCache = { at: Date.now(), key: CFG.workdir, data };
      sendJson(res, 200, data);
    });
  });
}

// ---------- live pm2 log streaming (SSE) ----------
function handleLogs(url, res) {
  const proc = (url.searchParams.get('proc') || '').toString();
  if (!/^[\w.-]{1,64}$/.test(proc)) return sendJson(res, 400, { error: 'invalid process name' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const ch = spawn('pm2', ['logs', proc, '--raw', '--lines', '60'], { windowsHide: true, shell: true });
  const fwd = (c) => { for (const l of c.toString().split(/\r?\n/)) if (l.trim()) res.write('data: ' + l.slice(0, 800) + '\n\n'); };
  ch.stdout.on('data', fwd);
  ch.stderr.on('data', fwd);
  const cap = setTimeout(() => { try { ch.kill(); } catch (_) {} res.end(); }, 10 * 60000);
  const bye = () => { clearTimeout(cap); try { process.kill(ch.pid); } catch (_) {} try { ch.kill(); } catch (_) {} };
  res.on('close', bye);
  ch.on('close', () => { clearTimeout(cap); try { res.end(); } catch (_) {} });
}

// ---------- multi-device ----------
// Forward an owner request to a peer's /agent surface; pipes body + response
// (JSON or SSE) transparently. Peers authenticate with the shared device token.
function proxyToDevice(dev, req, res, url) {
  const opts = {
    hostname: dev.host, port: dev.agentPort, method: req.method,
    path: '/agent' + url.pathname + (url.search || ''),
    headers: { ...req.headers, host: dev.host + ':' + dev.agentPort, 'x-device-token': CFG.deviceToken },
  };
  delete opts.headers.cookie;
  const up = http.request(opts, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', (e) => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'device unreachable: ' + String(e.message).slice(0, 120) }); else try { res.end(); } catch (_) {} });
  res.on('close', () => { try { up.destroy(); } catch (_) {} });
  req.on('error', () => { try { up.destroy(); } catch (_) {} });
  req.pipe(up);
}

// Snapshot of this node: pm2 processes + running task count + identity.
function deviceHealth(cb) {
  exec('pm2 jlist', { windowsHide: true, timeout: 5000, maxBuffer: 4e6 }, (err, stdout) => {
    let pm2 = [];
    try { pm2 = JSON.parse(stdout).map((pr) => ({ name: pr.name, status: (pr.pm2_env && pr.pm2_env.status) || '?', cpu: pr.monit ? pr.monit.cpu : null, memory: pr.monit ? pr.monit.memory : null })); } catch (_) {}
    let runningTasks = 0;
    try { const t = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')).tasks || {}; runningTasks = Object.values(t).filter((x) => x.status === 'running').length; } catch (_) {}
    cb({ ok: true, deviceId: CFG.deviceId, hostname: os.hostname(), role: CFG.role, workdir: CFG.workdir, pm2, runningTasks, ts: Date.now() });
  });
}
function handleDeviceHealth(res) { deviceHealth((h) => sendJson(res, 200, h)); }

// This node's SSH public key — surfaced in the Devices tab so the user can copy
// it to a peer's authorized_keys (used by scripts/phase2-ssh-keys.ps1 too).
function handleDevicePubkey(res) {
  const pubPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.ssh', 'id_ed25519.pub');
  let pubkey = '';
  try { pubkey = fs.readFileSync(pubPath, 'utf8').trim(); } catch (_) {}
  sendJson(res, 200, { ok: true, deviceId: CFG.deviceId, sshUser: os.userInfo().username, pubkey });
}

function pingDevice(dev, cb) {
  const r = http.request({ hostname: dev.host, port: dev.agentPort, path: '/agent/api/device/health', method: 'GET', headers: { 'x-device-token': CFG.deviceToken } }, (resp) => {
    let d = ''; resp.on('data', (c) => { d += c; }); resp.on('end', () => { try { const o = JSON.parse(d); cb(o && o.ok ? o : null); } catch (_) { cb(null); } });
  });
  r.on('error', () => cb(null));
  r.setTimeout(3500, () => { r.destroy(); cb(null); });
  r.end();
}

function handleDevicesList(res) {
  const list = DEVICES.slice();
  if (!list.find((d) => d.id === CFG.deviceId)) list.unshift({ id: CFG.deviceId, name: os.hostname() + ' (this)', host: 'self', agentPort: CFG.port, kind: CFG.role });
  const out = new Array(list.length);
  let pending = list.length;
  const done = () => sendJson(res, 200, { ok: true, deviceId: CFG.deviceId, hasToken: !!CFG.deviceToken, devices: out.filter(Boolean) });
  if (!pending) return done();
  list.forEach((d, i) => {
    if (d.id === CFG.deviceId) deviceHealth((h) => { out[i] = { ...d, self: true, online: true, health: h }; if (--pending === 0) done(); });
    else pingDevice(d, (h) => { out[i] = { ...d, self: false, online: !!h, health: h }; if (--pending === 0) done(); });
  });
}

function handleDevicesPost(req, res) {
  readBody(req, (body) => {
    let d = {}; try { d = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    const id = String(d.id || '').toLowerCase().trim();
    if (!/^[\w.-]{1,40}$/.test(id)) return sendJson(res, 400, { error: 'bad id' });
    if (!d.host || !/^[\w.:-]{1,80}$/.test(String(d.host))) return sendJson(res, 400, { error: 'host required' });
    DEVICES = loadDevices().filter((x) => x.id !== id);
    const entry = { id, name: d.name || id, host: String(d.host), agentPort: parseInt(d.agentPort || CFG.port, 10) || CFG.port, kind: d.kind || 'agent' };
    if (d.sshUser) entry.sshUser = String(d.sshUser).slice(0, 64);
    if (d.sshPort) entry.sshPort = parseInt(d.sshPort, 10) || 22;
    DEVICES.push(entry);
    saveDevices(DEVICES);
    sendJson(res, 200, { ok: true, devices: DEVICES });
  });
}

function handleDevicesDelete(p, res) {
  const id = decodeURIComponent(p.slice('/api/devices/'.length)).toLowerCase();
  DEVICES = loadDevices().filter((x) => x.id !== id);
  saveDevices(DEVICES);
  sendJson(res, 200, { ok: true, devices: DEVICES });
}

// ---------- live Claude-session console mirror ----------
// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — we list and tail these.
function claudeProjectsDir() { return path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects'); }

// Cheaply peek a transcript: cwd from the head, last real user prompt from the tail.
function peekSession(fp, size) {
  let fd;
  try { fd = fs.openSync(fp, 'r'); } catch (_) { return {}; }
  try {
    const headLen = Math.min(size, 4096);
    const headBuf = Buffer.alloc(headLen);
    fs.readSync(fd, headBuf, 0, headLen, 0);
    let cwd = (headBuf.toString('utf8').match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1];
    if (cwd) { try { cwd = JSON.parse('"' + cwd + '"'); } catch (_) {} }
    const tailLen = Math.min(size, 16384);
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);
    const lines = tailBuf.toString('utf8').split('\n').filter(Boolean);
    let lastPrompt = '';
    for (let i = lines.length - 1; i >= 0 && !lastPrompt; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o.type === 'user' && o.message) {
          const c = o.message.content;
          const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
          if (txt && !txt.trimStart().startsWith('<')) lastPrompt = txt.replace(/\s+/g, ' ').slice(0, 110);
        }
      } catch (_) {}
    }
    return { cwd, lastPrompt };
  } catch (_) { return {}; }
  finally { try { fs.closeSync(fd); } catch (_) {} }
}

function listSessions() {
  const base = claudeProjectsDir();
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { return []; }
  const now = Date.now();
  const out = [];
  for (const proj of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(base, proj)).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(base, proj, f);
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      if (!st.size) continue;
      const meta = peekSession(fp, st.size);
      out.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        project: proj,
        cwd: meta.cwd || proj,
        startedAt: st.birthtimeMs || st.ctimeMs,
        lastActivity: st.mtimeMs,
        // A terminal session sitting idle waiting for input still has a recent
        // mtime; treat the last 10 min as "active" so live terminals surface.
        status: (now - st.mtimeMs < 600000) ? 'active' : 'idle',
        lastPrompt: meta.lastPrompt || '',
      });
    }
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity);
  return out.slice(0, 100);
}
function handleSessionsList(res) { sendJson(res, 200, { ok: true, deviceId: CFG.deviceId, sessions: listSessions() }); }

// Turn one transcript line into compact render events for the mirror.
function transcriptEvents(o) {
  const ev = [];
  const ts = o.timestamp ? Date.parse(o.timestamp) : Date.now();
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    if (txt.trim() && !txt.trimStart().startsWith('<command-')) ev.push({ kind: 'user', text: txt.slice(0, 4000), ts });
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
      let r = b.content; if (Array.isArray(r)) r = r.map((x) => x.text || '').join('\n');
      ev.push({ kind: 'tool-result', text: String(r || '').slice(0, 1500), ts });
    }
  } else if (o.type === 'assistant' && o.message) {
    for (const b of (o.message.content || [])) {
      if (b.type === 'text' && b.text.trim()) ev.push({ kind: 'assistant', text: b.text, ts });
      else if (b.type === 'tool_use') ev.push({ kind: 'tool', tool: b.name, input: summarizeToolInput(b.input), ts });
      else if (b.type === 'thinking' && b.thinking) ev.push({ kind: 'thinking', text: b.thinking.slice(0, 1500), ts });
    }
  }
  return ev;
}
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const k = input.file_path || input.path || input.command || input.pattern || input.url || input.prompt || input.description;
  return k ? String(k).replace(/\s+/g, ' ').slice(0, 120) : '';
}

function findSessionFile(sessionId) {
  if (!/^[\w-]{6,80}$/.test(sessionId)) return null;
  const base = claudeProjectsDir();
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch (_) { return null; }
  for (const d of dirs) {
    const fp = path.join(base, d, sessionId + '.jsonl');
    try { if (fs.existsSync(fp)) return fp; } catch (_) {}
  }
  return null;
}

// SSE: replay the last slice of a transcript, then tail it live (poll + offset).
function handleSessionStream(res, sessionId) {
  const fp = findSessionFile(sessionId);
  if (!fp) return sendJson(res, 404, { error: 'session not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let offset = 0, buf = '', alive = true;
  try { const s0 = fs.statSync(fp); if (s0.size > 250000) offset = s0.size - 250000; } catch (_) {}
  const pump = () => {
    if (!alive) return;
    let st; try { st = fs.statSync(fp); } catch (_) { return; }
    if (st.size < offset) { offset = 0; buf = ''; }
    if (st.size <= offset) return;
    let fd; try { fd = fs.openSync(fp, 'r'); } catch (_) { return; }
    const len = st.size - offset;
    const b = Buffer.alloc(len);
    try { fs.readSync(fd, b, 0, len, offset); } catch (_) { try { fs.closeSync(fd); } catch (_) {} return; }
    try { fs.closeSync(fd); } catch (_) {}
    offset = st.size;
    buf += b.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (_) { continue; }
      for (const e of transcriptEvents(o)) { try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch (_) {} }
    }
  };
  pump();
  const t = setInterval(pump, 800);
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 25000);
  const bye = () => { alive = false; clearInterval(t); clearInterval(hb); try { res.end(); } catch (_) {} };
  res.on('close', bye);
}

// ---------- skills manager ----------
function userSkillsDir() { return path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'skills'); }
function projectSkillsDir() { return path.join(CFG.workdir, '.claude', 'skills'); }
const SKILL_SLUG = /^[a-z0-9-]{1,60}$/;

function parseSkillMd(fp) {
  let txt = ''; try { txt = fs.readFileSync(fp, 'utf8'); } catch (_) { return {}; }
  const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const get = (k) => fm ? ((fm[1].match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1] || '').trim().replace(/^["']|["']$/g, '') : '';
  return { name: get('name'), description: get('description') };
}
function listSkills() {
  const out = [];
  for (const [scope, dir] of [['user', userSkillsDir()], ['project', projectSkillsDir()]]) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { continue; }
    for (const d of names) {
      const fp = path.join(dir, d, 'SKILL.md');
      if (fs.existsSync(fp)) { const m = parseSkillMd(fp); out.push({ slug: d, scope, name: m.name || d, description: m.description || '' }); }
    }
  }
  return out;
}
function handleSkillsList(res) { sendJson(res, 200, { ok: true, deviceId: CFG.deviceId, skillsDir: userSkillsDir(), skills: listSkills() }); }

function handleSkillsPost(req, res) {
  readBody(req, (body) => {
    let d = {}; try { d = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    const slug = String(d.name || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!slug) return sendJson(res, 400, { error: 'name required' });
    const desc = String(d.description || '').replace(/\r?\n/g, ' ').slice(0, 300);
    const skbody = String(d.body || '').slice(0, 20000);
    const dir = path.join(userSkillsDir(), slug);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${desc}\n---\n\n${skbody || ('# ' + slug + '\n')}`);
    } catch (e) { return sendJson(res, 500, { error: String(e.message).slice(0, 200) }); }
    sendJson(res, 200, { ok: true, slug });
  });
}
function handleSkillGet(res, slug) {
  if (!SKILL_SLUG.test(slug)) return sendJson(res, 400, { error: 'bad slug' });
  for (const dir of [userSkillsDir(), projectSkillsDir()]) {
    const fp = path.join(dir, slug, 'SKILL.md');
    if (fs.existsSync(fp)) { try { return sendJson(res, 200, { ok: true, slug, content: fs.readFileSync(fp, 'utf8').slice(0, 40000) }); } catch (_) {} }
  }
  sendJson(res, 404, { error: 'not found' });
}
function handleSkillPut(req, res, slug) {
  if (!SKILL_SLUG.test(slug)) return sendJson(res, 400, { error: 'bad slug' });
  readBody(req, (body) => {
    let d = {}; try { d = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    const dir = path.join(userSkillsDir(), slug);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), String(d.content || '').slice(0, 40000)); }
    catch (e) { return sendJson(res, 500, { error: String(e.message).slice(0, 200) }); }
    sendJson(res, 200, { ok: true });
  });
}
function handleSkillDelete(res, slug) {
  if (!SKILL_SLUG.test(slug)) return sendJson(res, 400, { error: 'bad slug' });
  try { fs.rmSync(path.join(userSkillsDir(), slug), { recursive: true, force: true }); } catch (_) {}
  sendJson(res, 200, { ok: true });
}

// ---------- task bridge ----------
// Start a headless Claude run on THIS node (the proxy makes ?device= run it on a
// peer). It's a real Claude session, so its transcript + the user-level hooks
// surface it in the Sessions mirror and the dashboard's console tasks.
const HUB_TASKS_FILE = path.join(__dirname, 'hub-tasks.json');
function loadHubTasks() { try { return JSON.parse(fs.readFileSync(HUB_TASKS_FILE, 'utf8')); } catch (_) { return []; } }
function saveHubTasks(t) { try { fs.writeFileSync(HUB_TASKS_FILE, JSON.stringify(t, null, 2)); } catch (_) {} }
function updateTask(id, patch) { const t = loadHubTasks(); const x = t.find((z) => z.id === id); if (x) { Object.assign(x, patch); saveHubTasks(t); } }
function handleTasksList(res) { sendJson(res, 200, { ok: true, deviceId: CFG.deviceId, tasks: loadHubTasks().slice(0, 40) }); }

function handleTasksPost(req, res) {
  readBody(req, (body) => {
    let d = {}; try { d = JSON.parse(body); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    const prompt = (d.prompt || '').toString().trim();
    if (!prompt) return sendJson(res, 400, { error: 'prompt required' });
    const model = (d.model || CFG.model).toString();
    const workdir = (d.workdir && /^[A-Za-z]:[\\/]/.test(d.workdir) && fs.existsSync(d.workdir)) ? d.workdir : CFG.workdir;
    const sessionId = crypto.randomUUID();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model, '--permission-mode', 'bypassPermissions', '--session-id', sessionId];
    let child;
    try { child = spawn(CLAUDE.command, [...CLAUDE.prefix, ...args], { cwd: workdir, shell: CLAUDE.shell, windowsHide: true }); }
    catch (e) { return sendJson(res, 500, { error: 'spawn failed: ' + String(e.message).slice(0, 160) }); }
    const task = { id: 'task-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), sessionId, device: CFG.deviceId, prompt: prompt.slice(0, 300), model, workdir, status: 'running', pid: child.pid, startedAt: Date.now() };
    const tasks = loadHubTasks(); tasks.unshift(task); if (tasks.length > 100) tasks.length = 100; saveHubTasks(tasks);
    child.on('error', () => { updateTask(task.id, { status: 'failed', finishedAt: Date.now() }); notifyOwnerWA('❌ Task failed: ' + task.prompt.slice(0, 100)); });
    child.on('close', (code) => {
      updateTask(task.id, { status: code ? 'failed' : 'done', finishedAt: Date.now() });
      const mins = Math.round((Date.now() - task.startedAt) / 60000);
      notifyOwnerWA(`${code ? '❌ Task failed' : '✅ Task done'} (${mins}m): ${task.prompt.slice(0, 120)}`);
    });
    if (child.stdout) child.stdout.on('data', () => {}); // drain to avoid backpressure
    if (child.stderr) child.stderr.on('data', () => {});
    try {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
      child.stdin.end();
    } catch (_) {}
    sendJson(res, 200, { ok: true, id: task.id, sessionId });
  });
}
function handleTaskStop(res, id) {
  const t = loadHubTasks(); const x = t.find((z) => z.id === id);
  if (!x) return sendJson(res, 404, { error: 'not found' });
  if (x.pid) { try { process.kill(x.pid); } catch (_) {} }
  x.status = 'cancelled'; x.finishedAt = Date.now(); saveHubTasks(t);
  sendJson(res, 200, { ok: true });
}

// ---------- token analytics ----------
const USAGE_LOG_FILE = path.join(__dirname, 'usage-log.json');
function logUsage(model, usage) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(USAGE_LOG_FILE, 'utf8')); } catch (_) {}
    log.push({ ts: Date.now(), model: String(model || ''), in: usage.input_tokens || 0, out: usage.output_tokens || 0, cr: usage.cache_read_input_tokens || 0 });
    if (log.length > 6000) log = log.slice(-5000);
    fs.writeFileSync(USAGE_LOG_FILE, JSON.stringify(log));
  } catch (_) {}
}
function handleAnalytics(res) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(USAGE_LOG_FILE, 'utf8')); } catch (_) {}
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key.slice(5), key, in: 0, out: 0, turns: 0 });
  }
  const byKey = Object.fromEntries(days.map((d) => [d.key, d]));
  for (const e of log) {
    const k = new Date(e.ts).toISOString().slice(0, 10);
    const d = byKey[k];
    if (d) { d.in += e.in + (e.cr || 0); d.out += e.out; d.turns++; }
  }
  const totals = days.reduce((a, d) => ({ in: a.in + d.in, out: a.out + d.out, turns: a.turns + d.turns }), { in: 0, out: 0, turns: 0 });
  sendJson(res, 200, { ok: true, days, totals });
}

// ---------- scheduled workflows ----------
// schedule: { type:'every', minutes:N } | { type:'daily', time:'HH:MM' }; lastRun on the entry.
function workflowDue(wf, now) {
  const s = wf.schedule;
  if (!s || !s.type) return false;
  if (s.type === 'every') {
    const min = Math.max(5, parseInt(s.minutes, 10) || 0);
    if (!min) return false;
    return !wf.lastRun || now - wf.lastRun >= min * 60000;
  }
  if (s.type === 'daily') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.time || '');
    if (!m) return false;
    const today = new Date(); today.setHours(+m[1], +m[2], 0, 0);
    return now >= today.getTime() && (!wf.lastRun || wf.lastRun < today.getTime());
  }
  return false;
}

let wfRunning = false;
setInterval(() => {
  if (wfRunning) return;
  const now = Date.now();
  const wfs = loadWorkflows();
  const due = wfs.find((w) => workflowDue(w, now));
  if (!due) return;
  due.lastRun = now;
  saveWorkflows(wfs);
  wfRunning = true;
  console.log('[scheduler] running workflow: ' + due.name);
  const ch = spawn(CLAUDE.command, [...CLAUDE.prefix, '-p', '--model', CFG.model, '--output-format', 'text', '--permission-mode', CFG.permissionMode], {
    cwd: CFG.workdir, shell: CLAUDE.shell, windowsHide: true,
  });
  let out = '';
  ch.stdout.on('data', (c) => { out += c; });
  const cap = setTimeout(() => { try { ch.kill(); } catch (_) {} }, 10 * 60000);
  ch.on('error', () => { clearTimeout(cap); wfRunning = false; });
  ch.on('close', () => {
    clearTimeout(cap);
    wfRunning = false;
    const id = 'wf-' + new Date().toISOString().replace(/[:.]/g, '-');
    const conv = createConv(id, CFG.model, CFG.workdir);
    conv.title = '⏰ ' + due.name + ' — ' + new Date().toLocaleString();
    conv.messages.push({ role: 'user', text: due.prompt, ts: now });
    conv.messages.push({ role: 'assistant', text: out.trim() || '(no output)', ts: Date.now() });
    saveConv(conv);
    console.log('[scheduler] workflow done: ' + due.name + ' → ' + id);
  });
  ch.stdin.write(due.prompt);
  ch.stdin.end();
}, 60000);

// ---------- tiny helpers ----------
function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 1e6) { req.destroy(); }
  });
  req.on('end', () => cb(data));
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function loadDotEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      const i = l.indexOf('=');
      if (i < 0) continue;
      const k = l.slice(0, i).trim();
      let v = l.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (_) {}
}
