// memory-bridge: stdio MCP server Claude spawns per-session.
// Proxies memory tool calls to the persistent memory-store daemon (port 8094).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = process.env.MEMORY_STORE_URL || "http://127.0.0.1:8094";

async function call(path, method = "GET", body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.text();
  } catch (e) {
    return JSON.stringify({ error: `Memory store unreachable: ${e.message}` });
  }
}

const server = new McpServer({ name: "memory", version: "1.0.0" });

server.tool(
  "memory_search",
  "Search the persistent memory store. Use this to answer questions like 'what did X say about Y', 'what happened on Tuesday', 'any messages about dinner', 'events this week'. Supports natural language date expressions: 'yesterday', 'tuesday', 'last week', '3 days ago'.",
  {
    query: z.string().optional().describe("Keywords or phrase to search for in memory content"),
    person: z.string().optional().describe("Filter by person name (partial match)"),
    dateFrom: z.string().optional().describe("Start date — natural language OK: 'yesterday', 'monday', 'last week', 'june 5'"),
    dateTo: z.string().optional().describe("End date — natural language OK. Defaults to now if omitted."),
    topic: z.string().optional().describe("Filter by topic tag"),
    type: z.enum(["conversation", "note", "event", "fact", "reminder"]).optional().describe("Filter by memory type"),
    limit: z.number().optional().default(20).describe("Max results (default 20)"),
  },
  async (params) => ({ content: [{ type: "text", text: await call("/search", "POST", params) }] })
);

server.tool(
  "memory_add",
  "Add a note, fact, or event to persistent memory. Use for things the user explicitly wants remembered, important facts about people, or events with dates.",
  {
    content: z.string().describe("The memory content to store"),
    type: z.enum(["note", "fact", "event", "reminder"]).optional().default("note").describe("Memory type"),
    person: z.string().optional().describe("Person this memory is about"),
    topic: z.string().optional().describe("Topic tag (e.g. 'college', 'family', 'health')"),
    summary: z.string().optional().describe("One-line summary for quick display"),
    eventDate: z.number().optional().describe("Unix timestamp (ms) if this is a future/past event"),
  },
  async (params) => ({
    content: [{ type: "text", text: await call("/add", "POST", { ...params, source: "manual" }) }],
  })
);

server.tool(
  "memory_recent",
  "Get recent memory entries. Useful for context on what was recently discussed or happened.",
  {
    limit: z.number().optional().default(20).describe("Number of recent entries"),
    person: z.string().optional().describe("Filter by person name"),
    type: z.enum(["conversation", "note", "event", "fact", "reminder"]).optional().describe("Filter by type"),
  },
  async (params) => ({
    content: [{ type: "text", text: await call(`/recent?limit=${params.limit || 20}${params.person ? `&person=${encodeURIComponent(params.person)}` : ''}${params.type ? `&type=${params.type}` : ''}`) }],
  })
);

server.tool(
  "memory_stats",
  "Show memory store statistics — total entries, breakdown by type and source, database size.",
  {},
  async () => ({ content: [{ type: "text", text: await call("/stats") }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`memory-bridge MCP running (forwarding to ${API})`);
