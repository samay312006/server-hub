// gmail-bridge: stdio MCP server Claude spawns per-session.
// Proxies Gmail tool calls to the persistent gmail-monitor daemon (port 8093).
// Requires gmail-monitor to be running: pm2 start ecosystem.config.js --only gmail-monitor

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.GMAIL_MONITOR_URL || "http://127.0.0.1:8093";

async function call(path, method = "GET", body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return text;
  } catch (e) {
    return JSON.stringify({
      error: `Gmail monitor unreachable at ${API}: ${e.message}`,
      hint: "Start it with: pm2 start ecosystem.config.js --only gmail-monitor",
    });
  }
}

const server = new McpServer({ name: "gmail", version: "1.0.0" });

server.tool(
  "gmail_list_accounts",
  "List all Gmail accounts being monitored",
  {},
  async () => ({ content: [{ type: "text", text: await call("/accounts") }] })
);

server.tool(
  "gmail_search",
  "Search emails across all monitored accounts using Gmail query syntax. Use this to answer questions like 'any email about X', 'what event is on June 15', 'emails from VIT about fees', etc. Query examples: 'subject:exam after:2024/06/01', 'from:placement@vit.ac.in', 'fee OR attendance OR result'. Searches ALL accounts by default.",
  {
    query: z.string().describe("Gmail search query string"),
    account: z.string().optional().describe("Specific account to search. Omit to search all monitored accounts."),
    maxResults: z.number().optional().default(15).describe("Max emails to return (default 15)"),
  },
  async ({ query, account, maxResults }) => ({
    content: [{ type: "text", text: await call("/search", "POST", { query, account, maxResults }) }],
  })
);

server.tool(
  "gmail_get_email",
  "Get the full content of a specific email by its ID (from gmail_search results). Returns headers, snippet, decoded body text, and labels.",
  {
    id: z.string().describe("Gmail message ID from search results"),
    account: z.string().describe("Gmail account the email belongs to"),
  },
  async ({ id, account }) => ({
    content: [{ type: "text", text: await call("/get-message", "POST", { id, account }) }],
  })
);

server.tool(
  "gmail_status",
  "Check Gmail monitor status — polling state, accounts, last check times",
  {},
  async () => ({ content: [{ type: "text", text: await call("/status") }] })
);

server.tool(
  "gmail_poll_now",
  "Trigger an immediate inbox poll across all accounts (don't wait for the next scheduled interval)",
  {},
  async () => ({ content: [{ type: "text", text: await call("/poll-now", "POST") }] })
);

server.tool(
  "gmail_mark_feedback",
  "Train the email importance classifier. Mark a sender as important (always notify) or spam (never notify). Use the shortId from digest messages.",
  {
    shortId: z.string().describe("8-character email shortId from the WhatsApp digest (e.g. 'a3f9bc12')"),
    action: z.enum(["important", "spam"]).describe("Mark as important or spam"),
  },
  async ({ shortId, action }) => {
    // Look up the full sender from recent emails
    const recentRaw = await call("/recent-emails");
    let recent = {};
    try { recent = JSON.parse(recentRaw); } catch (_) {}
    const entry = recent[shortId];
    if (!entry) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `ID #${shortId} not found in recent emails (IDs expire after 24h)` }) }] };
    }
    const result = await call("/feedback", "POST", { from: entry.from, action });
    return { content: [{ type: "text", text: result }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`gmail-bridge MCP running (forwarding to ${API})`);
