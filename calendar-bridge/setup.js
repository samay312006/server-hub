#!/usr/bin/env node
// One-time setup for Google Calendar bridge.
// Usage:
//   node setup.js add <email>     — Authorize a Google account via browser
//   node setup.js list            — List authorized accounts
//   node setup.js remove <email>  — Remove an account's token
//   node setup.js test <email>    — Test the calendar connection
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`\n⚠️  No .env found at ${envPath}\n`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { authorizeAccount, getAuthClientForAccount, loadToken, TOKENS_DIR } = await import('./oauth.js');
const { google } = await import('googleapis');

const cmd = process.argv[2];
const arg = process.argv[3];

function filenameToEmail(f) {
  return f.replace(/_dot_/g, '.').replace(/_at_/g, '@').replace(/\.json$/, '');
}

if (cmd === 'add') {
  if (!arg) { console.error('Usage: node setup.js add <email@gmail.com>'); process.exit(1); }
  try {
    await authorizeAccount(arg);
    console.log(`\n✅ ${arg} authorized for Google Calendar.`);
    console.log(`   Add it to CALENDAR_ACCOUNTS in calendar-bridge/.env if not already there.\n`);
  } catch (e) {
    console.error('❌ Authorization failed:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === 'list') {
  if (!fs.existsSync(TOKENS_DIR)) { console.log('No accounts authorized yet.'); process.exit(0); }
  const files = fs.readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('No accounts authorized yet.'); process.exit(0); }
  console.log('\nAuthorized Calendar accounts:\n');
  for (const f of files) {
    const email = filenameToEmail(f);
    const token = loadToken(email);
    const exp = token?.expiry_date ? new Date(token.expiry_date).toLocaleString() : 'N/A';
    console.log(`  ✅ ${email} (expires: ${exp})`);
  }
  console.log('');
  process.exit(0);
}

if (cmd === 'remove') {
  if (!arg) { console.error('Usage: node setup.js remove <email>'); process.exit(1); }
  const f = path.join(TOKENS_DIR, `${arg.replace(/@/g, '_at_').replace(/[.]/g, '_dot_')}.json`);
  if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`✅ Removed token for ${arg}`); }
  else console.log(`⚠️  No token found for ${arg}`);
  process.exit(0);
}

if (cmd === 'test') {
  if (!arg) { console.error('Usage: node setup.js test <email>'); process.exit(1); }
  try {
    const auth = getAuthClientForAccount(arg);
    const cal = google.calendar({ version: 'v3', auth });
    const now = new Date().toISOString();
    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin: now,
      maxResults: 3,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = res.data.items || [];
    console.log(`\n✅ Calendar OK for ${arg}`);
    console.log(`   Next ${events.length} event(s):`);
    for (const e of events) {
      const start = e.start?.dateTime || e.start?.date || '?';
      console.log(`   • ${e.summary} @ ${start}`);
    }
    console.log('');
  } catch (e) {
    console.error(`❌ Failed for ${arg}:`, e.message);
    process.exit(1);
  }
  process.exit(0);
}

console.log(`
Google Calendar Bridge Setup
══════════════════════════════════════

BEFORE YOU START:
  1. In Google Cloud Console (same project as Gmail):
     APIs & Services → Library → search "Google Calendar API" → Enable
  2. Credentials → your OAuth client → Authorized redirect URIs
     must include: http://localhost:4321/oauth2callback (already registered)

COMMANDS:
  node setup.js add <email>      Authorize an account (opens browser)
  node setup.js list             List authorized accounts
  node setup.js remove <email>   Remove an account
  node setup.js test <email>     Test calendar API connection

AFTER SETUP:
  The calendar-bridge MCP is registered automatically.
  Use /cal in WhatsApp to interact with your calendars.
`);
process.exit(0);
