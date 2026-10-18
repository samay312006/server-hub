import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEEDBACK_FILE = path.join(__dirname, 'classifier-feedback.json');
const RECENT_FILE = path.join(__dirname, 'recent-emails.json');

// Senders that are always noise — no-reply, newsletters, automated alerts
const NOISE_PATTERNS = [
  /no.?reply/i, /noreply/i, /do.not.reply/i, /donotreply/i,
  /newsletter/i, /unsubscribe/i, /mailer-daemon/i,
  /notifications?@/i, /updates?@(?!gmail)/i, /alerts?@/i,
  /digest@/i, /weekly@/i, /marketing@/i, /promotions?@/i,
];

// Gmail system labels that indicate low-value mail
const SKIP_LABELS = new Set([
  'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES',
  'CATEGORY_FORUMS', 'SPAM',
]);

// VIT and institutional email domains — handled with secondary personal-relevance check,
// NOT auto-approved (most VIT mass mail is not personally relevant)
const INSTITUTIONAL_DOMAINS = [
  /@vit\.ac\.in/i, /@vitstudent\.ac\.in/i,
  /@vitap\.ac\.in/i, /@vitbhopal\.ac\.in/i,
];

// Keywords that make an institutional email personally relevant or compulsory.
// Generic event announcements, club mails, and mass circulars won't match these.
const INSTITUTIONAL_PERSONAL_KEYWORDS = [
  // Academic standing
  'attendance', 'shortage', 'detained', 'debarred',
  'backlog', 'arrear', 'reappear', 'supplementary',
  'cgpa', 'gpa', 'grade', 'marksheet', 'transcript',
  'result', 'exam schedule', 'hall ticket', 'admit card',
  'internal mark', 'assignment submission', 'project submission',
  // Financial
  'fee', 'due', 'fine', 'penalty', 'payment', 'hostel fee',
  'scholarship', 'stipend', 'refund',
  // Placement & internship
  'placement', 'internship', 'offer letter', 'selected', 'shortlisted',
  'interview', 'aptitude', 'pre-placement',
  // Registration & admin
  'registration', 'enroll', 're-register', 'course add', 'course drop',
  'timetable change', 'slot change',
  // Urgency signals
  'compulsory', 'mandatory', 'must attend', 'last date', 'deadline',
  'warning', 'notice', 'action required', 'failure to',
  'your application', 'your request',
];

function loadFeedback() {
  try {
    if (!fs.existsSync(FEEDBACK_FILE)) return { senderReputation: {}, processedIds: [] };
    return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  } catch { return { senderReputation: {}, processedIds: [] }; }
}

function saveFeedback(data) {
  try { fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

export function normalizeSender(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).toLowerCase().trim();
}

export function recordFeedback(from, action) {
  const email = normalizeSender(from);
  const data = loadFeedback();
  if (!data.senderReputation[email]) data.senderReputation[email] = 0;
  data.senderReputation[email] += action === 'important' ? 1 : -1;
  saveFeedback(data);
  return data.senderReputation[email];
}

export function isProcessed(messageId) {
  return loadFeedback().processedIds.includes(messageId);
}

export function markProcessed(messageId) {
  const data = loadFeedback();
  data.processedIds.push(messageId);
  if (data.processedIds.length > 5000) data.processedIds = data.processedIds.slice(-5000);
  saveFeedback(data);
}

export function saveRecentEmails(emails) {
  const store = loadRecentEmails();
  for (const e of emails) {
    store[e.shortId] = { from: e.from, account: e.account, subject: e.subject, ts: Date.now() };
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const k of Object.keys(store)) { if (store[k].ts < cutoff) delete store[k]; }
  try { fs.writeFileSync(RECENT_FILE, JSON.stringify(store, null, 2)); } catch (_) {}
}

export function loadRecentEmails() {
  try {
    if (!fs.existsSync(RECENT_FILE)) return {};
    return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
  } catch { return {}; }
}

export function classifyEmail({ from, subject, labels = [] }) {
  const data = loadFeedback();
  const senderEmail = normalizeSender(from);
  const subjectLower = (subject || '').toLowerCase();

  // ── Hard skips ─────────────────────────────────────────────────────────────
  if (labels.some(l => SKIP_LABELS.has(l))) return { important: false, reason: 'label' };
  if (NOISE_PATTERNS.some(p => p.test(from))) return { important: false, reason: 'noise-sender' };

  // ── User feedback overrides everything ────────────────────────────────────
  const rep = data.senderReputation[senderEmail] || 0;
  if (rep <= -2) return { important: false, reason: 'learned-spam' };
  if (rep >= 2) return { important: true, reason: 'learned-important' };

  // ── Institutional email (VIT etc): secondary personal-relevance check ─────
  // Don't auto-approve all VIT mail — most is mass/generic. Only flag if the
  // subject contains a keyword that signals personal or compulsory relevance.
  const isInstitutional = INSTITUTIONAL_DOMAINS.some(p => p.test(from));
  if (isInstitutional) {
    const hit = INSTITUTIONAL_PERSONAL_KEYWORDS.find(k => subjectLower.includes(k));
    if (hit) return { important: true, reason: `vit-personal:${hit}` };
    // User feedback can still whitelist a specific VIT sender via /email-important
    return { important: false, reason: 'vit-generic' };
  }

  // ── Env sender whitelist (non-institutional) ──────────────────────────────
  const whitelist = (process.env.SENDER_WHITELIST || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (whitelist.some(s => from.toLowerCase().includes(s))) {
    return { important: true, reason: 'whitelist' };
  }

  // ── Subject keyword match ─────────────────────────────────────────────────
  const keywords = (process.env.IMPORTANT_KEYWORDS ||
    'urgent,important,deadline,interview,offer letter,result,admit,selected,rejected,payment,otp,verification,action required,verify,confirm,due date,overdue,expiring')
    .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  const hit = keywords.find(k => subjectLower.includes(k));
  if (hit) return { important: true, reason: `keyword:${hit}` };

  return { important: false, reason: 'no-match' };
}
