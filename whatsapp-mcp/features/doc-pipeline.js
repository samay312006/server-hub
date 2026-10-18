// Feature 9: Document Intelligence Pipeline
// PDF/image → text extraction → memory-store + optional Notion push.
// Handles both text-based PDFs (pdf-parse) and scanned docs/images (Claude vision).

import { readFile } from 'fs/promises';

// Extract text from a text-based PDF. Returns empty string if extraction fails
// or the PDF is scanned (too little text). Caller should fall back to Claude vision.
export async function extractPdfText(filePath) {
  try {
    // Import from the lib path to skip pdf-parse's self-test that fires at module load
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
    const buffer = await readFile(filePath);
    const data = await pdfParse(buffer, { max: 0 }); // max:0 = all pages
    return (data.text || '').trim();
  } catch (e) {
    console.error('[doc-pipeline] pdf-parse failed:', e.message);
    return '';
  }
}

// Prompt for images or scanned PDFs — Claude vision reads and transcribes the file.
export function buildDocOcrPrompt(filePath, title, chatId, mimeType) {
  return (
    `A user has sent a document for indexing.\n` +
    `Title: "${title}"\n` +
    `File: ${filePath} (${mimeType})\n\n` +
    `Steps:\n` +
    `1. Read the file at ${filePath} — use your file reading / vision tools to view its contents.\n` +
    `2. Extract ALL visible text. Preserve structure: headings, lists, tables, bullet points.\n` +
    `3. Save the full extracted content to memory using memory_add:\n` +
    `   { type: "document", content: "<full text, max 8000 chars>", person: "me",\n` +
    `     source: "whatsapp-doc",\n` +
    `     metadata: { title: "${title}", mimeType: "${mimeType}", extractedAt: "<ISO now>" } }\n` +
    `4. Send a WhatsApp confirmation to chat "${chatId}":\n` +
    `   📄 *${title}*\n` +
    `   [word count] words indexed\n` +
    `   [2-3 sentence summary of what the document contains]\n` +
    `   Use /doc search <query> to search it\n\n` +
    `Keep the WhatsApp reply under 600 chars.`
  );
}

// Prompt for text-based PDFs where text was already extracted by pdf-parse.
// Also used for .txt, .csv, and other plain-text files.
export function buildDocSavePrompt(text, title, chatId, mimeType, filePath = null) {
  const contentSection = text
    ? `Extracted text (${text.length} chars):\n---\n${text.slice(0, 6000)}${text.length > 6000 ? '\n[truncated…]' : ''}\n---`
    : `Read the file directly: ${filePath}`;

  return (
    `A user has sent a document for indexing.\n` +
    `Title: "${title}" (${mimeType})\n\n` +
    `${contentSection}\n\n` +
    `Steps:\n` +
    `1. Understand what the document is about.\n` +
    `2. Save to memory using memory_add:\n` +
    `   { type: "document", content: "<full text, max 8000 chars>", person: "me",\n` +
    `     source: "whatsapp-doc",\n` +
    `     metadata: { title: "${title}", mimeType: "${mimeType}",\n` +
    `                 wordCount: <count>, pages: <if PDF> } }\n` +
    `3. Send a WhatsApp confirmation to chat "${chatId}":\n` +
    `   📄 *${title}*\n` +
    `   [word count] words indexed\n` +
    `   [2-3 sentence summary]\n` +
    `   Key topics: [comma-separated]\n` +
    `   Use /doc search <query> to search it\n\n` +
    `Keep the WhatsApp reply under 600 chars.`
  );
}

// Search across all stored documents in memory.
export function buildDocSearchPrompt(query, chatId) {
  return (
    `Search my indexed documents for: "${query}"\n\n` +
    `Steps:\n` +
    `1. Use memory_search with type="document" and query="${query}"\n` +
    `2. Also try memory_search with just query="${query}" (broader search)\n` +
    `3. Send results to WhatsApp chat "${chatId}":\n\n` +
    `*📄 Document Search: "${query}"*\n` +
    `[N result(s)]\n\n` +
    `1. *Title* — [2-line excerpt showing the relevant passage]\n` +
    `2. ...\n\n` +
    `If nothing found:\n` +
    `"No documents match '${query}'. Index a document first: send a PDF or photo with caption /doc <title>"\n\n` +
    `Keep the reply under 800 chars.`
  );
}

// List all indexed documents.
export function buildDocListPrompt(chatId) {
  return (
    `List all my indexed documents from memory.\n\n` +
    `Steps:\n` +
    `1. Use memory_search with type="document" and query="" or a very broad query like "document"\n` +
    `2. Send a list to WhatsApp chat "${chatId}":\n\n` +
    `*📚 Indexed Documents*\n` +
    `1. *Title* — [date indexed] — [10-word description]\n` +
    `2. ...\n\n` +
    `If none found:\n` +
    `"No documents indexed yet.\nSend any PDF or photo with caption: /doc <title>"\n\n` +
    `Keep the reply under 600 chars.`
  );
}

// Push a document from memory to a Notion page.
export function buildDocNotionPrompt(titleQuery, chatId) {
  return (
    `Push one of my indexed documents to Notion.\n` +
    `The user wants to push: "${titleQuery}"\n\n` +
    `Steps:\n` +
    `1. Use memory_search with type="document" and query="${titleQuery}" to find the document\n` +
    `2. Pick the best match\n` +
    `3. Use notion_workspaces to see available workspaces\n` +
    `4. Use notion_create_page to create a new page:\n` +
    `   - Title: [document title]\n` +
    `   - Content: [the full extracted text from memory]\n` +
    `   - Put it in the most relevant workspace (Personal if unsure)\n` +
    `5. Send confirmation to chat "${chatId}" with the Notion page URL\n\n` +
    `If no matching document found in memory: tell the user and suggest /doc <title> to index it first.`
  );
}
