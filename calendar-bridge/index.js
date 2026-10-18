// calendar-bridge: stdio MCP server — Google Calendar across multiple accounts.
// Accounts configured via CALENDAR_ACCOUNTS in .env.
// Tokens stored in calendar-bridge/tokens/ (one file per account).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { getAuthClientForAccount } = await import("./oauth.js");

const TZ = process.env.TIMEZONE || "Asia/Kolkata";
const ACCOUNTS = (process.env.CALENDAR_ACCOUNTS || "").split(",").map(e => e.trim()).filter(Boolean);

// Build a googleapis calendar client per account
const clients = {};
for (const email of ACCOUNTS) {
  try {
    const auth = getAuthClientForAccount(email);
    clients[email] = google.calendar({ version: "v3", auth });
    console.error(`✅ Calendar loaded: ${email}`);
  } catch (e) {
    console.error(`⚠️  Skipping ${email}: ${e.message}`);
  }
}

const activeAccounts = Object.keys(clients);
console.error(`calendar-bridge: ${activeAccounts.length} account(s) — ${activeAccounts.join(", ") || "none"}`);

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtEvent(e, account) {
  const start = e.start?.dateTime || e.start?.date;
  const end = e.end?.dateTime || e.end?.date;
  return {
    id: e.id,
    account,
    summary: e.summary || "(no title)",
    start,
    end,
    location: e.location || null,
    description: e.description || null,
    status: e.status,
    link: e.htmlLink,
    hangout: e.hangoutLink || null,
    attendees: (e.attendees || []).map(a => ({ email: a.email, status: a.responseStatus })),
  };
}

function resolveClients(account) {
  if (account) {
    const c = clients[account];
    if (!c) return { error: `Account ${account} not configured. Available: ${activeAccounts.join(", ")}` };
    return { targets: [{ email: account, cal: c }] };
  }
  return { targets: activeAccounts.map(e => ({ email: e, cal: clients[e] })) };
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "calendar", version: "1.0.0" });

server.tool(
  "calendar_list_accounts",
  "List all authorized Google Calendar accounts available in this bridge.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({ accounts: activeAccounts, timezone: TZ }),
    }],
  })
);

server.tool(
  "calendar_list_calendars",
  "List all calendars (personal, shared, subscribed) for one or all accounts.",
  {
    account: z.string().optional().describe("Specific account email. Omit to list all accounts."),
  },
  async ({ account }) => {
    const { targets, error } = resolveClients(account);
    if (error) return { content: [{ type: "text", text: JSON.stringify({ error }) }] };
    const out = [];
    for (const { email, cal } of targets) {
      try {
        const res = await cal.calendarList.list();
        out.push({
          account: email,
          calendars: (res.data.items || []).map(c => ({
            id: c.id,
            name: c.summary,
            primary: c.primary || false,
            accessRole: c.accessRole,
          })),
        });
      } catch (e) {
        out.push({ account: email, error: e.message });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "calendar_get_events",
  "Get upcoming or past calendar events for a date range. Returns events sorted by start time.",
  {
    time_min: z.string().describe("Start datetime in ISO 8601, e.g. 2026-06-12T00:00:00+05:30"),
    time_max: z.string().describe("End datetime in ISO 8601, e.g. 2026-06-12T23:59:59+05:30"),
    account: z.string().optional().describe("Email of specific account. Omit to query all accounts."),
    calendar_id: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
    max_results: z.number().optional().default(20).describe("Max events to return per account"),
  },
  async ({ time_min, time_max, account, calendar_id, max_results }) => {
    const { targets, error } = resolveClients(account);
    if (error) return { content: [{ type: "text", text: JSON.stringify({ error }) }] };
    const out = [];
    for (const { email, cal } of targets) {
      try {
        const res = await cal.events.list({
          calendarId: calendar_id || "primary",
          timeMin: time_min,
          timeMax: time_max,
          maxResults: max_results || 20,
          singleEvents: true,
          orderBy: "startTime",
          timeZone: TZ,
        });
        out.push({ account: email, count: res.data.items?.length || 0, events: (res.data.items || []).map(e => fmtEvent(e, email)) });
      } catch (e) {
        out.push({ account: email, error: e.message });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

server.tool(
  "calendar_create_event",
  "Create a new calendar event with full control over timing, location, and description.",
  {
    account: z.string().describe("Gmail account to create the event in (e.g. you@gmail.com)"),
    summary: z.string().describe("Event title"),
    start: z.string().describe("Start datetime in ISO 8601, e.g. 2026-06-13T14:00:00"),
    end: z.string().describe("End datetime in ISO 8601, e.g. 2026-06-13T15:00:00"),
    location: z.string().optional().describe("Event location (address, room, or 'Online')"),
    description: z.string().optional().describe("Event notes or description"),
    calendar_id: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
    attendees: z.array(z.string()).optional().describe("Email addresses of attendees"),
    all_day: z.boolean().optional().describe("If true, start/end should be dates (YYYY-MM-DD), not datetimes"),
  },
  async ({ account, summary, start, end, location, description, calendar_id, attendees, all_day }) => {
    const cal = clients[account];
    if (!cal) return { content: [{ type: "text", text: JSON.stringify({ error: `Account ${account} not configured.` }) }] };
    try {
      const startObj = all_day ? { date: start } : { dateTime: start, timeZone: TZ };
      const endObj = all_day ? { date: end } : { dateTime: end, timeZone: TZ };
      const event = {
        summary,
        start: startObj,
        end: endObj,
        location,
        description,
        attendees: attendees?.map(e => ({ email: e })),
      };
      const res = await cal.events.insert({ calendarId: calendar_id || "primary", resource: event });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, event: fmtEvent(res.data, account) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

server.tool(
  "calendar_quick_add",
  "Create a calendar event using natural language. Google interprets text like 'Team meeting tomorrow at 3pm for 1 hour at VIT'.",
  {
    account: z.string().describe("Gmail account to create the event in"),
    text: z.string().describe("Natural language event description, e.g. 'Dentist appointment next Monday at 10am'"),
    calendar_id: z.string().optional().default("primary").describe("Calendar ID (default: primary)"),
  },
  async ({ account, text, calendar_id }) => {
    const cal = clients[account];
    if (!cal) return { content: [{ type: "text", text: JSON.stringify({ error: `Account ${account} not configured.` }) }] };
    try {
      const res = await cal.events.quickAdd({ calendarId: calendar_id || "primary", text });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, event: fmtEvent(res.data, account) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

server.tool(
  "calendar_update_event",
  "Update an existing calendar event's title, time, location, or description.",
  {
    account: z.string().describe("Gmail account the event belongs to"),
    event_id: z.string().describe("Event ID from calendar_get_events"),
    calendar_id: z.string().optional().default("primary"),
    summary: z.string().optional().describe("New title"),
    start: z.string().optional().describe("New start datetime (ISO 8601)"),
    end: z.string().optional().describe("New end datetime (ISO 8601)"),
    location: z.string().optional().describe("New location"),
    description: z.string().optional().describe("New description"),
  },
  async ({ account, event_id, calendar_id, summary, start, end, location, description }) => {
    const cal = clients[account];
    if (!cal) return { content: [{ type: "text", text: JSON.stringify({ error: `Account ${account} not configured.` }) }] };
    try {
      const existing = await cal.events.get({ calendarId: calendar_id || "primary", eventId: event_id });
      const patch = { ...existing.data };
      if (summary) patch.summary = summary;
      if (location !== undefined) patch.location = location;
      if (description !== undefined) patch.description = description;
      if (start) patch.start = { dateTime: start, timeZone: TZ };
      if (end) patch.end = { dateTime: end, timeZone: TZ };
      const res = await cal.events.update({ calendarId: calendar_id || "primary", eventId: event_id, resource: patch });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, event: fmtEvent(res.data, account) }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

server.tool(
  "calendar_delete_event",
  "Delete a calendar event permanently.",
  {
    account: z.string().describe("Gmail account the event belongs to"),
    event_id: z.string().describe("Event ID from calendar_get_events"),
    calendar_id: z.string().optional().default("primary"),
  },
  async ({ account, event_id, calendar_id }) => {
    const cal = clients[account];
    if (!cal) return { content: [{ type: "text", text: JSON.stringify({ error: `Account ${account} not configured.` }) }] };
    try {
      await cal.events.delete({ calendarId: calendar_id || "primary", eventId: event_id });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ error: e.message }) }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
