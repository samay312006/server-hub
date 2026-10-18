import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_FILE = path.join(__dirname, '..', 'user-profile.json');

export function loadProfile() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    // Strip the _note field before passing to Claude
    const { _note, ...profile } = raw;
    return profile;
  } catch { return {}; }
}

const IMPORTANT_RE = /college|universit|\.edu\b|admission|scholarship|application|\.gov\.|\.gov\.in|nic\.in|mhrd|ugc|aicte|bank|financ|loan|income.?tax|passport|visa|neet|jee|upsc|gate\b|cat\b|insurance|policy|form\.gov|epfo|esic/i;

export function classifyFormImportance(url) {
  return IMPORTANT_RE.test(url) ? 'important' : 'simple';
}

export function extractUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

export function buildFillPrompt({ url, profile, chatId, importance }) {
  const profileStr = JSON.stringify(profile, null, 2);

  const submitBlock = importance === 'important'
    ? `⚠️ IMPORTANT FORM (college/financial/official): After filling all fields, DO NOT submit yet.
  a. Take a Playwright screenshot and send it to WhatsApp chat "${chatId}" using the send_media tool.
  b. Then send this exact text to "${chatId}" via send_message:
     "📋 *Form Review Ready*
     🔗 ${url}

     *Fields filled:*
     [list every field label and the exact value entered]

     ⚠️ Please review carefully.
     Reply */fill-confirm* to submit • */fill-cancel* to abort"`
    : `SIMPLE FORM: Fill all fields and submit directly.
  After successful submission, take a screenshot of the confirmation page and send it to "${chatId}" via send_media.
  Then send a text: "✅ Form submitted successfully!\n🔗 ${url}"`;

  return `You are autonomously filling an online form for the owner.

STEPS:
1. Navigate to: ${url}
2. Take a browser snapshot to see all form fields.
3. Fill each field using the USER PROFILE below. Use context and judgment for fields not in the profile.
4. If any CRITICAL field is missing (specific ID numbers, document numbers, application-specific data the profile doesn't have):
   - Send a WhatsApp message to "${chatId}" listing exactly what you need (field name + why it's needed).
   - Then stop and wait for the user to reply.
5. ${submitBlock}

USER PROFILE:
${profileStr}

RULES:
- Never invent critical identifiers (Aadhar, PAN, document numbers) — ask instead.
- For optional fields not in the profile, leave blank or skip.
- Match dropdown/select options to the nearest profile value.
- Send a brief "🔄 Filling form..." status to "${chatId}" when you begin.
- After filling (before any submit), take a screenshot regardless of form type.`;
}
