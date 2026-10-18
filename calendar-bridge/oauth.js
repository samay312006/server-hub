import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TOKENS_DIR = path.join(__dirname, 'tokens');

// Reuse the same redirect port as gmail-monitor (already registered in Cloud Console)
const REDIRECT_PORT = 4321;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

export function getOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in calendar-bridge/.env');
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

function tokenPath(email) {
  return path.join(TOKENS_DIR, `${email.replace(/@/g, '_at_').replace(/[.]/g, '_dot_')}.json`);
}

export function loadToken(email) {
  const p = tokenPath(email);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function saveToken(email, tokens) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
  fs.writeFileSync(tokenPath(email), JSON.stringify(tokens, null, 2));
}

export function getAuthClientForAccount(email) {
  const tokens = loadToken(email);
  if (!tokens) throw new Error(`No token for ${email}. Run: node setup.js add ${email}`);
  const client = getOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (fresh) => {
    saveToken(email, { ...tokens, ...fresh });
    console.error(`[calendar-oauth] Token refreshed for ${email}`);
  });
  return client;
}

export async function authorizeAccount(email) {
  const client = getOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    login_hint: email,
    prompt: 'consent',
  });

  console.log(`\n🔐 Authorizing: ${email}`);
  console.log(`Opening browser... if it doesn't open, paste this URL:\n\n${authUrl}\n`);
  try { (await import('child_process')).exec(`start "" "${authUrl}"`); } catch (_) {}

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error) { res.end(`<h2>❌ ${error}</h2>`); server.close(); return reject(new Error(error)); }
      if (!code) { res.end('Waiting...'); return; }
      res.end('<h2>✅ Calendar authorized! You can close this tab.</h2>');
      server.close();
      try {
        const { tokens } = await client.getToken(code);
        saveToken(email, tokens);
        console.log(`✅ Token saved for ${email}`);
        resolve(tokens);
      } catch (e) { reject(e); }
    });
    server.listen(REDIRECT_PORT, 'localhost', () =>
      console.log(`Waiting for callback on http://localhost:${REDIRECT_PORT}...`)
    );
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout (3 min)')); }, 3 * 60 * 1000);
  });
}
