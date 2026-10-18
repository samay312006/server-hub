// notion-bridge: stdio MCP server — multi-workspace Notion access.
// Loads NOTION_TOKEN_N / NOTION_LABEL_N pairs from mcp/.env.
// Each token is a Notion Internal Integration secret (one per workspace).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@notionhq/client";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from same directory
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// Build workspace list from NOTION_TOKEN_1..N + NOTION_LABEL_1..N
const workspaces = [];
for (let i = 1; i <= 10; i++) {
  const token = process.env[`NOTION_TOKEN_${i}`];
  if (!token) break;
  const label = process.env[`NOTION_LABEL_${i}`] || `Workspace ${i}`;
  workspaces.push({ index: i, label, client: new Client({ auth: token }) });
}

console.error(`notion-bridge: ${workspaces.length} workspace(s) — ${workspaces.map(w => w.label).join(", ") || "none configured"}`);

// ── Helpers ────────────────────────────────────────────────────────────────────

function cleanId(input) {
  // Accept full URLs, UUIDs with/without dashes, or raw 32-char hex
  const m = (input || "").match(/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i);
  return m ? m[1].replace(/-/g, "") : input;
}

function pageTitle(item) {
  return (
    item.properties?.title?.title?.[0]?.plain_text ||
    item.properties?.Name?.title?.[0]?.plain_text ||
    item.title?.[0]?.plain_text ||
    "(untitled)"
  );
}

function fmtPage(item) {
  return {
    id: item.id,
    type: item.object,
    title: pageTitle(item),
    url: item.url,
    created: item.created_time,
    edited: item.last_edited_time,
    parent: item.parent,
  };
}

function fmtBlock(block) {
  const t = block.type;
  const rich = block[t]?.rich_text?.map(r => r.plain_text).join("") || "";
  return { id: block.id, type: t, text: rich };
}

// ── MCP Tools ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "notion", version: "1.0.0" });

server.tool(
  "notion_workspaces",
  "List all configured Notion workspaces with their index numbers. Call this first to know which index to use in other tools.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({ workspaces: workspaces.map(w => ({ index: w.index, label: w.label })) }),
    }],
  })
);

server.tool(
  "notion_search",
  "Search across all (or one) Notion workspace for pages and databases matching a query. Returns titles, IDs, and URLs.",
  {
    query: z.string().describe("Search query — keywords, page title, or topic"),
    filter: z.enum(["page", "database"]).optional().describe("Restrict to pages or databases only"),
    workspace_index: z.number().optional().describe("Search only this workspace (1-based). Omit to search all."),
    limit: z.number().optional().default(10).describe("Max results per workspace (default 10)"),
  },
  async ({ query, filter, workspace_index, limit }) => {
    const targets = workspace_index ? workspaces.filter(w => w.index === workspace_index) : workspaces;
    const out = [];
    for (const ws of targets) {
      try {
        const res = await ws.client.search({
          query,
          filter: filter ? { property: "object", value: filter } : undefined,
          page_size: limit || 10,
        });
        out.push({ workspace: ws.label, workspace_index: ws.index, count: res.results.length, results: res.results.map(fmtPage) });
      } catch (e) {
        out.push({ workspace: ws.label, workspace_index: ws.index, error: e.message });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "notion_get_page",
  "Get a Notion page's properties and content blocks by its ID. Tries all workspaces unless workspace_index is given.",
  {
    page_id: z.string().describe("Notion page ID (UUID or full URL)"),
    workspace_index: z.number().optional().describe("Workspace index (1-based) to try first"),
    max_blocks: z.number().optional().default(50).describe("Max content blocks to return"),
  },
  async ({ page_id, workspace_index, max_blocks }) => {
    const id = cleanId(page_id);
    const ordered = workspace_index
      ? [...workspaces.filter(w => w.index === workspace_index), ...workspaces.filter(w => w.index !== workspace_index)]
      : workspaces;
    for (const ws of ordered) {
      try {
        const [page, blocks] = await Promise.all([
          ws.client.pages.retrieve({ page_id: id }),
          ws.client.blocks.children.list({ block_id: id, page_size: max_blocks || 50 }),
        ]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ workspace: ws.label, workspace_index: ws.index, page: fmtPage(page), blocks: blocks.results.map(fmtBlock) }, null, 2),
          }],
        };
      } catch (_) {}
    }
    return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found in any workspace. Make sure the integration has access." }) }] };
  }
);

server.tool(
  "notion_create_page",
  "Create a new Notion page under a parent page or inside a database. Returns the new page URL.",
  {
    workspace_index: z.number().describe("Workspace index (1-based) — use notion_workspaces to get indices"),
    parent_id: z.string().describe("Parent page ID or database ID where the new page will live"),
    parent_type: z.enum(["page", "database"]).default("page").describe("Whether the parent is a page or database"),
    title: z.string().describe("Page title"),
    content: z.string().optional().describe("Body text to add as the first paragraph block"),
  },
  async ({ workspace_index, parent_id, parent_type, title, content }) => {
    const ws = workspaces.find(w => w.index === workspace_index);
    if (!ws) return { content: [{ type: "text", text: JSON.stringify({ error: `No workspace at index ${workspace_index}` }) }] };
    try {
      const parent = parent_type === "database"
        ? { database_id: cleanId(parent_id) }
        : { page_id: cleanId(parent_id) };
      const props = parent_type === "database"
        ? { Name: { title: [{ type: "text", text: { content: title } }] } }
        : { title: { title: [{ type: "text", text: { content: title } }] } };
      const page = await ws.client.pages.create({
        parent,
        properties: props,
        children: content
          ? [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content } }] } }]
          : [],
      });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, workspace: ws.label, id: page.id, url: page.url }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

server.tool(
  "notion_append_to_page",
  "Append text content to an existing Notion page.",
  {
    page_id: z.string().describe("Notion page ID"),
    workspace_index: z.number().optional().describe("Workspace index (1-based)"),
    text: z.string().describe("Text to append as a new paragraph"),
    heading: z.string().optional().describe("Optional heading to add before the text"),
  },
  async ({ page_id, workspace_index, text, heading }) => {
    const id = cleanId(page_id);
    const ordered = workspace_index
      ? [...workspaces.filter(w => w.index === workspace_index), ...workspaces.filter(w => w.index !== workspace_index)]
      : workspaces;
    for (const ws of ordered) {
      try {
        const children = [];
        if (heading) children.push({ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: heading } }] } });
        children.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } });
        await ws.client.blocks.children.append({ block_id: id, children });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, workspace: ws.label }) }] };
      } catch (_) {}
    }
    return { content: [{ type: "text", text: JSON.stringify({ error: "Page not found in any workspace" }) }] };
  }
);

server.tool(
  "notion_list_databases",
  "List all databases accessible in all (or one) workspace.",
  {
    workspace_index: z.number().optional().describe("Limit to a specific workspace (1-based). Omit for all."),
  },
  async ({ workspace_index }) => {
    const targets = workspace_index ? workspaces.filter(w => w.index === workspace_index) : workspaces;
    const out = [];
    for (const ws of targets) {
      try {
        const res = await ws.client.search({ filter: { property: "object", value: "database" }, page_size: 20 });
        out.push({ workspace: ws.label, workspace_index: ws.index, databases: res.results.map(fmtPage) });
      } catch (e) {
        out.push({ workspace: ws.label, workspace_index: ws.index, error: e.message });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "notion_query_database",
  "Query a Notion database and return its entries, optionally filtered.",
  {
    database_id: z.string().describe("Notion database ID"),
    workspace_index: z.number().optional().describe("Workspace index (1-based)"),
    limit: z.number().optional().default(20).describe("Max entries to return"),
  },
  async ({ database_id, workspace_index, limit }) => {
    const id = cleanId(database_id);
    const ordered = workspace_index
      ? [...workspaces.filter(w => w.index === workspace_index), ...workspaces.filter(w => w.index !== workspace_index)]
      : workspaces;
    for (const ws of ordered) {
      try {
        const res = await ws.client.databases.query({ database_id: id, page_size: limit || 20 });
        return { content: [{ type: "text", text: JSON.stringify({ workspace: ws.label, workspace_index: ws.index, count: res.results.length, entries: res.results.map(fmtPage) }, null, 2) }] };
      } catch (_) {}
    }
    return { content: [{ type: "text", text: JSON.stringify({ error: "Database not found in any workspace" }) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
