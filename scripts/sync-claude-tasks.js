// Claude Code hook: keeps claude-tasks.json in sync so the webui dashboard
// can show what the console is working on.
//
// Wired to three hook events (see ~/.claude/settings.json):
//   - UserPromptSubmit  -> records the session as a running "task" (covers every
//                          console session, even ones that never call TaskCreate)
//   - Stop              -> marks the session entry completed
//   - PostToolUse on Task(Create|Update|Stop) -> richer per-task entries
//
// Claude Code pipes the hook payload as JSON to stdin.
"use strict";
const fs = require("fs");

const FILE = "C:\\server-hub\\claude-tasks.json";

let store = { tasks: {} };
try { store = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (_) {}
if (!store.tasks) store.tasks = {};

// dashboard styles: running | completed | failed | cancelled
const STATUS_MAP = { in_progress: "running", pending: "running", completed: "completed", deleted: "cancelled", cancelled: "cancelled", failed: "failed" };

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, ""));
  } catch (_) { process.exit(0); }

  const event = payload.hook_event_name || "PostToolUse";
  const { tool_name, tool_input = {} } = payload;
  const now = Date.now();

  // tool_response may arrive as an object, a JSON string, or a plain
  // human-readable string ("Task #1 created successfully: ...").
  let resp = payload.tool_response;
  let respText = "";
  if (typeof resp === "string") {
    respText = resp;
    try { resp = JSON.parse(resp); } catch (_) { resp = {}; }
  }
  resp = resp && typeof resp === "object" ? resp : {};
  if (!respText && typeof resp.content === "string") respText = resp.content;

  if (event === "UserPromptSubmit") {
    const sid = payload.session_id || "console";
    const key = "console-" + sid;
    const prompt = String(payload.prompt || "").replace(/\s+/g, " ").trim();
    const prev = store.tasks[key];
    store.tasks[key] = {
      id: key,
      description: "🖥 " + (prompt ? (prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt) : "console session"),
      status: "running",
      createdAt: prev?.createdAt || now,
      updatedAt: now,
    };
    delete store.tasks[key].finishedAt;
  } else if (event === "Stop" || event === "SubagentStop") {
    const key = "console-" + (payload.session_id || "console");
    if (store.tasks[key]) {
      store.tasks[key].status = "completed";
      store.tasks[key].updatedAt = now;
      store.tasks[key].finishedAt = now;
    }
  } else if (event === "PostToolUse") {
    const tid =
      resp.taskId || resp.task_id || resp.id ||
      tool_input.taskId || tool_input.task_id || tool_input.id ||
      (respText.match(/Task #(\w+)/i) || [])[1];

    if (tool_name === "TaskCreate") {
      const id = tid || "task-" + now;
      store.tasks[id] = {
        id,
        description: tool_input.subject || tool_input.description || resp.description || "(unnamed task)",
        status: "running",
        createdAt: now,
        updatedAt: now,
      };
    } else if (tool_name === "TaskUpdate" && tid) {
      const t = store.tasks[tid] || (store.tasks[tid] = { id: tid, description: "(task " + tid + ")", createdAt: now });
      const newStatus = tool_input.status || resp.status;
      if (newStatus) t.status = STATUS_MAP[newStatus] || newStatus;
      if (tool_input.subject) t.description = tool_input.subject;
      t.updatedAt = now;
      if (["completed", "cancelled", "failed"].includes(t.status)) t.finishedAt = now;
      else delete t.finishedAt;
    } else if (tool_name === "TaskStop" && tid && store.tasks[tid]) {
      store.tasks[tid].status = "cancelled";
      store.tasks[tid].updatedAt = now;
      store.tasks[tid].finishedAt = now;
    }
  }

  // Prune tasks finished more than 2 hours ago
  for (const [id, t] of Object.entries(store.tasks)) {
    if (t.finishedAt && now - t.finishedAt > 7200000) delete store.tasks[id];
  }

  try { fs.writeFileSync(FILE, JSON.stringify(store, null, 2)); } catch (_) {}
});
