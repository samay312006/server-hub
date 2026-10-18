// Feature 4: Research Agent — builds the Claude prompt for /research <query>
// Claude uses Playwright MCP to browse DuckDuckGo, visit top results, and
// return a concise WhatsApp-friendly summary with sources.

export function buildResearchPrompt(query, chatId) {
  return (
    `Research this for me and send a concise answer to WhatsApp:\n\n` +
    `Query: "${query}"\n\n` +
    `Steps:\n` +
    `1. Use Playwright to navigate to https://duckduckgo.com\n` +
    `2. Search for the query. Take a snapshot to read the results.\n` +
    `3. Visit the top 2–3 most relevant non-ad results and extract key facts.\n` +
    `4. If the query looks time-sensitive (news, events, prices), also check the News tab.\n` +
    `5. Send your summary to WhatsApp chat "${chatId}" in exactly this format:\n\n` +
    `*[Topic title]*\n` +
    `• [key fact or finding]\n` +
    `• [key fact or finding]\n` +
    `• [key fact or finding]\n` +
    `_Sources: site1.com, site2.com_\n\n` +
    `Guidelines:\n` +
    `- Total response under 900 characters — be concise\n` +
    `- Be factual; do not invent details\n` +
    `- If you can't find reliable information, say so clearly\n` +
    `- After sending, also save a summary to memory via memory_add with ` +
    `type="fact", topic="${query.slice(0, 60)}", content=your summary`
  );
}
