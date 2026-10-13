// NetPower PM — MCP server so Claude (claude.ai custom connector, Claude Desktop, Claude Code)
// can create and look up RFIs, punch items and daily log notes without opening the app.
//
// Transport: MCP "Streamable HTTP" — POST JSON-RPC, answered with application/json; GET → 405.
// Auth: each user's private connector link  /api/mcp?key=<userId>.<secret>  (made in the app's user menu).
// Every call runs with that user's permissions (same checks as the app).

import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";
import { checkRead, checkWrite, canSeePrivate } from "./pm.js";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const uid = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const now = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const fail = msg => { const e = new Error(msg); e.userFacing = true; throw e; };

// ── Tool definitions ──
const projectArg = { type: "string", description: "Project name, project number, or id (partial names are fine)" };
export const TOOLS = [
  { name: "list_projects", description: "List the NetPower projects you can access (name, number, status).", inputSchema: { type: "object", properties: {} } },
  { name: "list_people", description: "List the people on a project's team — use their names for RFI assignees or punch item assignees.", inputSchema: { type: "object", properties: { project: projectArg }, required: ["project"] } },
  { name: "list_rfis", description: "List RFIs on a project, newest first.", inputSchema: { type: "object", properties: { project: projectArg, status: { type: "string", enum: ["Draft", "Open", "Closed"], description: "Only this status" } }, required: ["project"] } },
  { name: "get_rfi", description: "Get one RFI with its question and responses.", inputSchema: { type: "object", properties: { project: projectArg, number: { type: "integer" } }, required: ["project", "number"] } },
  { name: "create_rfi", description: "Create an RFI (Request for Information) on a project. It opens immediately when it has at least one assignee, otherwise it is saved as a Draft. You (the connected user) are the RFI manager.",
    inputSchema: { type: "object", properties: {
      project: projectArg, subject: { type: "string", description: "Short title" }, question: { type: "string", description: "The full question" },
      assignees: { type: "array", items: { type: "string" }, description: "Names of the people who must answer (from list_people)" },
      due_date: { type: "string", description: "YYYY-MM-DD; defaults to 7 days from today" }, location: { type: "string" }, drawing: { type: "string", description: "Drawing / sheet number, e.g. E-201" },
      spec_section: { type: "string" }, draft: { type: "boolean", description: "Save as Draft even if assignees are given" }, private: { type: "boolean" }
    }, required: ["project", "subject", "question"] } },
  { name: "get_rfi_photo_link", description: "Get a link that opens an RFI's 'Add photos' screen in NetPower PM (phone camera or photo library). Photos shared in this chat can't be sent through the connector, so give the user this link to attach them.", inputSchema: { type: "object", properties: { project: projectArg, number: { type: "integer" } }, required: ["project", "number"] } },
  { name: "respond_to_rfi", description: "Add a response to an RFI, optionally as the official answer and/or closing it.", inputSchema: { type: "object", properties: { project: projectArg, number: { type: "integer" }, response: { type: "string" }, official: { type: "boolean" }, close: { type: "boolean" } }, required: ["project", "number", "response"] } },
  { name: "create_punch_item", description: "Create a punch list item on a project.", inputSchema: { type: "object", properties: { project: projectArg, title: { type: "string" }, description: { type: "string" }, location: { type: "string" }, assignee: { type: "string", description: "Name of the person who does the work" }, priority: { type: "string", enum: ["Low", "Medium", "High"] }, due_date: { type: "string", description: "YYYY-MM-DD" } }, required: ["project", "title"] } },
  { name: "add_daily_log_note", description: "Add a note (and optionally work performed) to a project's daily log for a date (default today). Creates the log if it doesn't exist.", inputSchema: { type: "object", properties: { project: projectArg, note: { type: "string" }, work_performed: { type: "string", description: "Description of work performed today" }, date: { type: "string", description: "YYYY-MM-DD" } }, required: ["project"] } },
  { name: "list_submittals", description: "List submittals on a project with status and ball-in-court.", inputSchema: { type: "object", properties: { project: projectArg, status: { type: "string" } }, required: ["project"] } }
];

// ── Helpers ──
async function findProject(ctx, ref) {
  const all = (await db.find(db.eq("Type", "project"))).filter(p => ctx.isMember(p.id) && p.data.status !== "Archived");
  const q = norm(ref);
  if (!q) fail("Which project? Use list_projects to see them.");
  const exact = all.filter(p => p.id === ref || norm(p.data.name) === q || norm(p.data.number) === q);
  const partial = exact.length ? exact : all.filter(p => norm(p.data.name).includes(q) || norm(p.data.number).includes(q) || q.includes(norm(p.data.name)));
  if (partial.length === 1) return partial[0];
  if (!partial.length) fail(`No project matches "${ref}". Projects you can access: ${all.map(p => p.data.name).join(", ") || "none"}.`);
  fail(`"${ref}" matches several projects: ${partial.map(p => p.data.name).join(", ")}. Be more specific.`);
}
async function teamOf(p) {
  const contacts = await db.find(db.eq("Type", "contact"));
  const ids = (p.data.team || []).map(t => t.contactId);
  return ids.length ? contacts.filter(c => ids.includes(c.id)) : contacts;
}
function matchPerson(list, name) {
  const q = norm(name);
  const hits = list.filter(c => norm(c.data.name) === q);
  const loose = hits.length ? hits : list.filter(c => norm(c.data.name).includes(q) || q.split(" ").every(w => norm(c.data.name).includes(w)));
  if (loose.length === 1) return loose[0];
  if (!loose.length) fail(`Nobody named "${name}" is on this project's team. Use list_people.`);
  fail(`"${name}" matches ${loose.map(c => c.data.name).join(", ")}. Use the full name.`);
}
const history = (ctx, text) => ({ at: now(), by: ctx.user.data.name, text });
const appUrl = (req, p, path) => `https://${req.headers["x-forwarded-host"] || req.headers.host}/pm#/p/${p.id}/${path}`;
async function save(ctx, rec, stored) {
  await checkWrite(ctx, rec, stored || null);
  const existing = await db.getMany([rec.id]);
  await db.save([rec], existing);
}
async function recordsOf(ctx, type, p) {
  await checkRead(ctx, type, p.id);
  return (await db.find(db.and([db.eq("Type", type), db.eq("ProjectID", p.id)]))).filter(r => canSeePrivate(ctx, r));
}
const contactName = (contacts, id) => (contacts.find(c => c.id === id) || { data: { name: "" } }).data.name;

// ── Tool implementations ──
export async function callTool(ctx, req, name, a) {
  a = a || {};
  switch (name) {
    case "list_projects": {
      const ps = (await db.find(db.eq("Type", "project"))).filter(p => ctx.isMember(p.id) && p.data.status !== "Archived");
      return ps.length ? ps.map(p => `• ${p.data.name}${p.data.number ? " (#" + p.data.number + ")" : ""} — ${p.data.status || "Active"}`).join("\n") : "You don't have access to any projects yet.";
    }
    case "list_people": {
      const p = await findProject(ctx, a.project);
      const team = await teamOf(p);
      const roles = Object.fromEntries((p.data.team || []).map(t => [t.contactId, t.role]));
      return `${p.data.name} team:\n` + team.map(c => `• ${c.data.name}${roles[c.id] ? " — " + roles[c.id] : ""}`).join("\n");
    }
    case "list_rfis": {
      const p = await findProject(ctx, a.project);
      const list = (await recordsOf(ctx, "rfi", p)).filter(r => !a.status || r.data.status === a.status).sort((x, y) => y.data.number - x.data.number);
      return list.length ? list.slice(0, 50).map(r => `• RFI #${r.data.number} [${r.data.status}] ${r.data.subject}${r.data.due ? " — due " + r.data.due : ""}`).join("\n") : "No RFIs found.";
    }
    case "get_rfi": {
      const p = await findProject(ctx, a.project);
      const r = (await recordsOf(ctx, "rfi", p)).find(x => Number(x.data.number) === Number(a.number));
      if (!r) fail(`RFI #${a.number} not found on ${p.data.name}.`);
      const contacts = await db.find(db.eq("Type", "contact"));
      const d = r.data;
      return [`RFI #${d.number}: ${d.subject}`, `Status: ${d.status} · Due: ${d.due || "—"} · Manager: ${contactName(contacts, d.managerId) || "—"}`,
        `Assignees: ${(d.assignees || []).map(i => contactName(contacts, i)).join(", ") || "—"}`, d.location ? `Location: ${d.location}` : "", d.drawing ? `Drawing: ${d.drawing}` : "",
        `\nQuestion:\n${d.question || ""}`, `\nResponses (${(d.responses || []).length}):`, ...(d.responses || []).map(x => `— ${x.by}${x.official ? " (OFFICIAL)" : ""}, ${x.at.slice(0, 10)}: ${x.text}`),
        `\nOpen in app: ${appUrl(req, p, "rfis/" + r.id)}`].filter(Boolean).join("\n");
    }
    case "create_rfi": {
      const p = await findProject(ctx, a.project);
      if (!String(a.subject || "").trim() || !String(a.question || "").trim()) fail("An RFI needs a subject and a question.");
      const team = await teamOf(p);
      const assignees = (a.assignees || []).map(n => matchPerson(team, n).id);
      const existing = await recordsOf(ctx, "rfi", p).catch(() => []);
      const number = existing.reduce((m, r) => Math.max(m, Number(r.data.number) || 0), 0) + 1;
      if (a.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(a.due_date)) fail("due_date must look like 2026-10-20");
      const open = assignees.length > 0 && !a.draft;
      const question = String(a.question).trim();
      const due = a.due_date || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      const rec = { id: uid("rfi"), type: "rfi", projectId: p.id, data: {
        subject: String(a.subject).trim().slice(0, 200), question, questionHtml: esc(question).replace(/\n/g, "<br>"), number, due,
        managerId: ctx.contactId, assignees, distribution: [], location: a.location || "", drawing: a.drawing || "", specSection: a.spec_section || "",
        private: !!a.private, status: open ? "Open" : "Draft", responses: [], attachments: [], createdBy: ctx.user.data.name, createdAt: now(),
        ...(open ? { openedAt: now() } : {}), createdById: ctx.contactId, createdByUserId: ctx.user.id, source: "Claude",
        history: [history(ctx, open ? "RFI created and opened (via Claude)" : "RFI created as draft (via Claude)")], updatedAt: now() } };
      await save(ctx, rec);
      return `Created RFI #${number} "${rec.data.subject}" on ${p.data.name} as ${rec.data.status}${open ? "" : assignees.length ? "" : " (no assignees yet — add them in the app or call again with assignees)"}. Due ${due}.\nOpen in app: ${appUrl(req, p, "rfis/" + rec.id)}\nAdd photos (tap on your phone to take or pick pictures): ${appUrl(req, p, "rfis/" + rec.id + "?addPhotos=1")}`;
    }
    case "get_rfi_photo_link": {
      const p = await findProject(ctx, a.project);
      const r = (await recordsOf(ctx, "rfi", p)).find(x => Number(x.data.number) === Number(a.number));
      if (!r) fail(`RFI #${a.number} not found on ${p.data.name}.`);
      return `Add photos to RFI #${r.data.number} "${r.data.subject}" here (opens the camera / photo picker in NetPower PM): ${appUrl(req, p, "rfis/" + r.id + "?addPhotos=1")}\nIt has ${(r.data.attachments || []).length} attachment(s) now.`;
    }
    case "respond_to_rfi": {
      const p = await findProject(ctx, a.project);
      const r = (await recordsOf(ctx, "rfi", p)).find(x => Number(x.data.number) === Number(a.number));
      if (!r) fail(`RFI #${a.number} not found on ${p.data.name}.`);
      if (r.data.status === "Draft") fail("This RFI is still a draft — open it in the app before adding responses.");
      const text = String(a.response || "").trim();
      if (!text) fail("The response is empty.");
      const next = { ...r, data: { ...r.data, responses: [...(r.data.responses || []), { id: uid("rsp"), by: ctx.user.data.name, byId: ctx.contactId, at: now(), text, official: !!a.official }],
        ...(a.close ? { status: "Closed", closedAt: now() } : {}), updatedAt: now() } };
      next.data.history = [...(r.data.history || []), history(ctx, (a.official ? "Official response added" : "Response added") + (a.close ? " and RFI closed" : "") + " (via Claude)")];
      await save(ctx, next, r);
      return `Response added to RFI #${r.data.number}${a.close ? " and the RFI is now Closed" : ""}.\nOpen in app: ${appUrl(req, p, "rfis/" + r.id)}`;
    }
    case "create_punch_item": {
      const p = await findProject(ctx, a.project);
      if (!String(a.title || "").trim()) fail("A punch item needs a title.");
      const assignee = a.assignee ? matchPerson(await teamOf(p), a.assignee).id : "";
      const existing = await recordsOf(ctx, "punch", p).catch(() => []);
      const number = existing.reduce((m, r) => Math.max(m, Number(r.data.number) || 0), 0) + 1;
      const rec = { id: uid("pch"), type: "punch", projectId: p.id, data: {
        title: String(a.title).trim().slice(0, 200), description: a.description || "", location: a.location || "", assigneeId: assignee, managerId: ctx.contactId,
        priority: a.priority || "Medium", due: a.due_date || "", number, status: "Open", comments: [], createdBy: ctx.user.data.name, createdAt: now(), source: "Claude",
        history: [history(ctx, "Punch item created (via Claude)")], updatedAt: now() } };
      await save(ctx, rec);
      return `Created punch item #${number} "${rec.data.title}" on ${p.data.name}.\nOpen in app: ${appUrl(req, p, "punch/" + rec.id)}`;
    }
    case "add_daily_log_note": {
      const p = await findProject(ctx, a.project);
      const date = a.date || today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("date must look like 2026-10-20");
      if (!a.note && !a.work_performed) fail("Give a note or work_performed.");
      const id = "log_" + p.id + "_" + date.replace(/-/g, "");
      const stored = await db.get(id);
      if (stored && stored.data.locked) fail("That day's log is approved and locked.");
      const d = stored ? { ...stored.data } : { date, createdAt: now(), createdBy: ctx.user.data.name, manpower: [], work: [], notes: "" };
      if (a.note) d.notes = [d.notes, `${a.note} — ${ctx.user.data.name} (via Claude)`].filter(Boolean).join("\n");
      if (a.work_performed) d.work = [...(d.work || []), { area: "", description: a.work_performed, percent: "" }];
      d.updatedBy = ctx.user.data.name;
      d.updatedAt = now();
      d.history = [...(d.history || []), history(ctx, "Log updated (via Claude)")];
      await save(ctx, { id, type: "dailylog", projectId: p.id, data: d }, stored);
      return `Added to the ${date} daily log for ${p.data.name}.\nOpen in app: ${appUrl(req, p, "dailylog/" + date)}`;
    }
    case "list_submittals": {
      const p = await findProject(ctx, a.project);
      const list = (await recordsOf(ctx, "submittal", p)).filter(s => !a.status || s.data.status === a.status).sort((x, y) => x.data.number - y.data.number || x.data.revision - y.data.revision);
      return list.length ? list.slice(0, 60).map(s => `• #${s.data.number}.${s.data.revision || 0} [${s.data.status}] ${s.data.title}${s.data.due ? " — due " + s.data.due : ""}`).join("\n") : "No submittals found.";
    }
  }
  const e = new Error("Unknown tool: " + name); e.rpc = -32602; throw e;
}

// ── JSON-RPC ──
async function handleMessage(ctx, req, msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const reply = result => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const error = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return error(-32600, "Invalid request");
  switch (method) {
    case "initialize": {
      const v = params && VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "netpower-pm", version: "1.0.0" },
        instructions: `NetPower PM (construction project management). Connected as ${ctx.user.data.name}. Use list_projects first if the project is unclear. RFIs need a subject and question; add assignees (names from list_people) so the RFI opens right away. Photos from this chat can't be passed through the connector — after creating an RFI, give the user its "Add photos" link (also available from get_rfi_photo_link).` });
    }
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const name = params && params.name;
      if (!TOOLS.some(t => t.name === name)) return error(-32602, "Unknown tool: " + name);
      try {
        const text = await callTool(ctx, req, name, params.arguments);
        return reply({ content: [{ type: "text", text }] });
      } catch (e) {
        const msgText = e.userFacing ? e.message : e.status === 403 ? "You don't have permission to do that in NetPower PM: " + e.message : "NetPower PM error: " + e.message;
        return reply({ content: [{ type: "text", text: msgText }], isError: true });
      }
    }
    case "resources/list": return reply({ resources: [] });
    case "prompts/list": return reply({ prompts: [] });
    default:
      if (method.startsWith("notifications/")) return null;
      return error(-32601, "Method not found: " + method);
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "null"); } catch (e) { return undefined; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); res.status(405).json({ error: "Use POST (MCP Streamable HTTP)" }); return; }
  // Browsers on other sites must not be able to call this (DNS-rebinding / CSRF protection)
  const origin = req.headers.origin;
  if (origin && !/^https:\/\/([a-z0-9-]+\.)*(claude\.ai|anthropic\.com)$/.test(origin) && origin.replace(/^https?:\/\//, "") !== req.headers.host) { res.status(403).json({ error: "Origin not allowed" }); return; }
  const pv = req.headers["mcp-protocol-version"];
  if (pv && !VERSIONS.includes(pv)) { res.status(400).json({ error: "Unsupported MCP-Protocol-Version" }); return; }
  if (!db.configured()) { res.status(503).json({ error: "Database is not configured" }); return; }

  const key = (req.query && req.query.key) || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const ctx = await auth.contextFromKey(key).catch(() => null);
  if (!ctx) { res.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid or revoked NetPower connector link. Create a new one in NetPower PM → your name → Connect Claude." } }); return; }

  const msg = body(req);
  if (msg === undefined) { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  const batch = Array.isArray(msg) ? msg : [msg];
  const out = (await Promise.all(batch.map(m => handleMessage(ctx, req, m)))).filter(Boolean);
  if (!out.length) { res.status(202).end(); return; }
  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify(Array.isArray(msg) ? out : out[0]));
}
