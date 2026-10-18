#!/usr/bin/env node
// One-time setup CLI for Gmail Monitor.
// Usage:
//   node setup.js add <email>     — Authorize a Gmail account via browser
//   node setup.js list            — List authorized accounts and token status
//   node setup.js remove <email>  — Remove an account's token
//   node setup.js test <email>    — Quick connectivity test for an account
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from this directory
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const { config } = await import('dotenv');
  config({ path: envPath });
} else {
  console.error(`\n⚠️  No .env found at ${envPath}`);
  console.error('   Copy .env.example to .env and fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET\n');
  process.exit(1);
}

const { authorizeAccount, getAuthClientForAccount, loadToken } = await import('./oauth.js');
const { google } = await import('googleapis');

const TOKENS_DIR = path.join(__dirname, 'tokens');
const cmd = process.argv[2];
const arg = process.argv[3];

function emailToFilename(email) {
  return email.replace(/@/g, '_at_').replace(/[.]/g, '_dot_') + '.json';
}

function filenameToEmail(filename) {
  return filename.replace(/_dot_/g, '.').replace(/_at_/g, '@').replace('.json', '');
}

if (cmd === 'add') {
  if (!arg) {
    console.error('Usage: node setup.js add <your@gmail.com>');
    process.exit(1);
  }
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('\n❌ GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in gmail-monitor/.env');
    console.error('   Steps:\n   1. Go to console.cloud.google.com\n   2. Create a project\n   3. Enable Gmail API\n   4. Credentials → Create OAuth 2.0 Client ID (Desktop app)\n   5. Copy Client ID and Secret into gmail-monitor/.env\n');
    process.exit(1);
  }
  try {
    await authorizeAccount(arg);
    console.log(`\n✅ ${arg} authorized. Add it to GMAIL_ACCOUNTS in gmail-monitor/.env`);
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
  console.log(`\nAuthorized Gmail accounts:\n`);
  for (const f of files) {
    const email = filenameToEmail(f);
    const token = loadToken(email);
    const exp = token?.expiry_date ? new Date(token.expiry_date).toLocaleString() : 'N/A (refresh token)';
    console.log(`  ✅ ${email}`);
    console.log(`     Token expires: ${exp}`);
  }
  console.log('');
  process.exit(0);
}

if (cmd === 'remove') {
  if (!arg) { console.error('Usage: node setup.js remove <email>'); process.exit(1); }
  const tokenFile = path.join(TOKENS_DIR, emailToFilename(arg));
  if (fs.existsSync(tokenFile)) {
    fs.unlinkSync(tokenFile);
    console.log(`✅ Removed token for ${arg}`);
  } else {
    console.log(`⚠️  No token found for ${arg}`);
  }
  process.exit(0);
}

if (cmd === 'test') {
  if (!arg) { console.error('Usage: node setup.js test <email>'); process.exit(1); }
  try {
    const auth = getAuthClientForAccount(arg);
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log(`\n✅ Connection OK for ${arg}`);
    console.log(`   Email: ${profile.data.emailAddress}`);
    console.log(`   Messages total: ${profile.data.messagesTotal}`);
    console.log(`   Threads total: ${profile.data.threadsTotal}\n`);
  } catch (e) {
    console.error(`❌ Failed for ${arg}:`, e.message);
    process.exit(1);
  }
  process.exit(0);
}

// Default: show help
console.log(`
Gmail Monitor Setup
═══════════════════════════════════════

BEFORE YOU START:
  1. Go to console.cloud.google.com
  2. Create a project → Enable Gmail API
  3. APIs & Services → Credentials → Create OAuth 2.0 Client ID
  4. Type: Desktop app
  5. Copy Client ID + Secret into gmail-monitor/.env

COMMANDS:
  node setup.js add <email>      Authorize a Gmail account (opens browser)
  node setup.js list             List authorized accounts
  node setup.js remove <email>   Remove an account
  node setup.js test <email>     Test Gmail API connection

AFTER SETUP:
  1. Add account to GMAIL_ACCOUNTS in gmail-monitor/.env
  2. Set OWNER_CHAT_ID in gmail-monitor/.env
  3. pm2 start ecosystem.config.js --only gmail-monitor
`);
process.exit(0);
