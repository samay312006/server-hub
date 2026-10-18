// whatsapp-bridge: a tiny stdio MCP server Claude spawns per-session.
// It owns NO WhatsApp connection - it just forwards tool calls over HTTP to the
// persistent WhatsApp daemon (whatsapp-mcp/index.js) running under PM2.
// This avoids the "two WhatsApp clients on one login" conflict.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.WA_CONTROL_URL || "http://127.0.0.1:8091";

async function call(path, method, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return text;
  } catch (e) {
    return JSON.stringify({ error: `WhatsApp daemon unreachable at ${API}: ${e.message}` });
  }
}

const server = new McpServer({ name: "whatsapp", version: "1.0.0" });

server.tool("whatsapp_status", "Check if the WhatsApp connection is ready", {}, async () => ({
  content: [{ type: "text", text: await call("/status", "GET") }],
}));

server.tool("send_message", "Send a WhatsApp text message", {
  chatId: z.string().describe("Phone number with country code (e.g. 919876543210), or a chat ID"),
  message: z.string().describe("The text to send"),
}, async ({ chatId, message }) => ({
  content: [{ type: "text", text: await call("/send", "POST", { chatId, message }) }],
}));

server.tool("send_media", "Send an image or file to a WhatsApp chat", {
  chatId: z.string().describe("Phone number with country code, or a chat ID"),
  filePath: z.string().describe("Absolute path to the file on this machine (e.g. C:\\\\server-hub\\\\shots\\\\a.png)"),
  caption: z.string().optional().describe("Optional caption"),
}, async ({ chatId, filePath, caption }) => ({
  content: [{ type: "text", text: await call("/send-media", "POST", { chatId, filePath, caption }) }],
}));

server.tool("get_chats", "List recent WhatsApp chats", {
  limit: z.number().optional().default(20).describe("Max chats to return"),
}, async ({ limit }) => ({
  content: [{ type: "text", text: await call("/chats", "POST", { limit }) }],
}));

server.tool("search_contacts", "Search WhatsApp contacts by name", {
  query: z.string().describe("Name or partial name"),
}, async ({ query }) => ({
  content: [{ type: "text", text: await call("/search-contacts", "POST", { query }) }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("whatsapp-bridge MCP running (forwarding to " + API + ")");
