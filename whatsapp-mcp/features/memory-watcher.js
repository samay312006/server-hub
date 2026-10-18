// Passive WhatsApp conversation logger — Feature 3.
// Called on every message event. Stores to memory-store daemon, fire-and-forget.
// Filters out bot commands and media-only messages to keep the store clean.

const MEMORY_URL = process.env.MEMORY_STORE_URL || 'http://127.0.0.1:8094';

// Commands to skip — these are system actions, not conversational content
const SKIP_PATTERNS = /^\/(?:claude|fill|email|grok|gemini|memory|note|remind|research|event|notion|cal|group|track|untrack|tracks|price|doc|briefing)\b/i;

export async function captureMessage(msg, contactResolver) {
  const body = (msg.body || '').trim();

  // Skip commands, empty messages, and very short noise (single emoji, etc.)
  if (!body || SKIP_PATTERNS.test(body) || body.length < 2) return;

  let chat, contact;
  try {
    chat = await msg.getChat();
    contact = await msg.getContact();
  } catch { return; }

  // Person: resolved name > pushname > number
  const person = msg.fromMe
    ? 'me'
    : (contact.name || contact.pushname || msg.from.replace(/@.+/, ''));

  const entry = {
    type: 'conversation',
    content: body,
    person,
    chatId: chat.id._serialized,
    source: 'whatsapp',
    createdAt: (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    metadata: {
      from: msg.from,
      fromMe: msg.fromMe,
      chatName: chat.name || chat.id._serialized,
      isGroup: chat.isGroup,
      msgId: msg.id._serialized,
    },
  };

  // Fire and forget — never block message processing
  fetch(`${MEMORY_URL}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch(() => {}); // silently ignore if memory-store is down
}
