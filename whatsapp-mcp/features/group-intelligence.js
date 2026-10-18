// Feature 7: Group Intelligence — action item detection + summary prompt builders

// Pre-filter before calling Groq: only trigger on messages that look like task assignments
const ACTION_TRIGGERS = /\b(todo|to-do|action item|please|can you|could you|will you|need to|should|must|remind|follow.?up|deadline|submit|complete|finish|check|review|confirm|done by|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|eod|eow|end of))\b|@\w/i;

export function mightBeActionItem(text) {
  return ACTION_TRIGGERS.test(text);
}

// Calls Groq to extract a structured action item from a group message.
// Returns null if no clear action item is found.
export async function extractActionItem(text, groupName, senderName, groqKey) {
  if (!groqKey) return null;
  const today = new Date().toISOString().slice(0, 10);
  const prompt =
    `Analyze this WhatsApp group message for action items. Return ONLY valid JSON — no markdown.\n` +
    `{"isAction": boolean, "assignee": "person name or null", "action": "what needs doing (1 sentence)", "deadline": "YYYY-MM-DD or null", "summary": "4-word summary"}\n\n` +
    `Group: ${groupName}\nSent by: ${senderName}\nToday: ${today}\nMessage: ${text}\n\n` +
    `Rules:\n` +
    `- isAction=true only if someone is clearly asked to do something specific\n` +
    `- assignee: name of person being asked (from @mention or context), or null if unclear\n` +
    `- action: the specific task in plain language\n` +
    `- deadline: only if explicitly mentioned\n` +
    `- Casual chat / announcements without a task = isAction:false`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 120,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    if (!parsed?.isAction || !parsed?.action) return null;
    return { assignee: parsed.assignee || null, action: parsed.action, deadline: parsed.deadline || null, summary: parsed.summary || parsed.action.slice(0, 40) };
  } catch (_) {
    return null;
  }
}

export function buildGroupSummaryPrompt(groupName, chatId, hours = 24) {
  return (
    `Summarize the last ${hours} hours of activity in WhatsApp group "${groupName}".\n\n` +
    `Steps:\n` +
    `1. Use memory_search with query="${groupName}" and type="conversation" to find messages. Also try just the group name as the query.\n` +
    `2. Use memory_search with query="${groupName}" and type="action" to find action items.\n` +
    `3. Filter to the last ${hours} hours using the createdAt timestamps.\n` +
    `4. Send a summary to WhatsApp chat "${chatId}" in this format:\n\n` +
    `*📊 ${groupName} — Last ${hours}h*\n` +
    `[N messages from [X] people]\n\n` +
    `*Topics discussed:*\n• ...\n\n` +
    `*Action items:*\n• [task] → [person] (by [date or "no deadline"])\n\n` +
    `*Key updates:*\n• ...\n\n` +
    `Keep it under 900 characters. If there's nothing in memory yet, say so.`
  );
}

export function buildGroupActionsPrompt(groupName, chatId) {
  return (
    `List all pending action items tracked from WhatsApp group "${groupName}".\n\n` +
    `Steps:\n` +
    `1. Use memory_search with type="action" and query="${groupName}" to find saved action items.\n` +
    `2. Also try memory_search with topic="${groupName}".\n` +
    `3. Format as a numbered checklist and send to WhatsApp chat "${chatId}":\n\n` +
    `*📋 Action Items — ${groupName}*\n` +
    `1. [task] → [assignee] (by [deadline or "open"])\n` +
    `2. ...\n\n` +
    `If none found: "No action items tracked yet for ${groupName}. Use /group-watch in the group to start tracking."\n` +
    `Keep it concise.`
  );
}
