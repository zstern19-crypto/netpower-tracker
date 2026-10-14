// NetPower PM — in-app AI assistant (Claude). Answers questions about project data and can create RFIs,
// punch items and daily log notes, using the same tools and permission checks as the Claude connector (api/mcp.js).
//
//   GET  /api/assistant                    → { allowed, access, capUsd, monthCostUsd }
//   POST /api/assistant  { messages, text, projectId? }  → { messages, reply, actions, usage }
//   POST /api/assistant?action=settings  { access: "admins"|"everyone", capUsd }   (company admins)
//   POST /api/assistant?action=upload  { name, type, data (base64) }  → { fileId, kind, name, sig }
//        A photo or PDF for the next question. Stored with Anthropic's Files API (expires after 7 days); the
//        browser gets the file id plus a signature and sends both back — file ids without a valid signature
//        for this user are refused, so nobody can reference someone else's file.
//   POST /api/assistant?action=schedules  { projectId, files: [{ fileId, name }], fileSigs }  → { items, usage }
//        Reads the equipment schedules on mechanical / plumbing sheets (uploaded with action=upload) and returns
//        one row per piece of equipment, for the project's Equipment list. Needs Submittals "standard" on the project.
//
// The browser keeps the conversation (including Claude's thinking blocks, unchanged) and sends it back each turn;
// the system prompt and tools never change, so history stays valid and the prompt cache stays warm.
// Spending: each request's token usage is priced and added to a monthly total ("aiusage" record); requests stop
// once the month's cap is reached. Settings live in the "aisetting" record.

import Anthropic, { toFile } from "@anthropic-ai/sdk";
import * as db from "../lib/db.js";
import * as auth from "../lib/auth.js";
import { TOOLS, callTool } from "./mcp.js";

const MODEL = "claude-opus-5-5";
const MAX_STEPS = 8;              // model calls per question (each tool round is one)
const DEFAULT_CAP_USD = 25;       // per calendar month, until an admin changes it
const SETTINGS_ID = "aiset_company";
// $ per million tokens (first-party API list prices; fallback models are priced at the higher row to stay conservative)
const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  default: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
};

const SYSTEM = `You are the NetPower PM assistant for NetPower Electric, an electrical contractor. You help project managers, foremen and field crews with their construction projects in NetPower PM (a Procore-style app): RFIs, submittals, punch lists, daily logs, people and projects.

How to work:
- Use the tools to look things up instead of guessing. If the project is unclear, call list_projects (or ask).
- You may create RFIs, respond to RFIs, create punch items, create tasks and add daily log notes when the user asks you to. If key details are missing (which project, who should answer an RFI), ask one short question first. Never invent people — use list_people for names.
- After creating or changing something, say exactly what you did and include the link the tool returned.
- The user can attach photos and PDFs to a message, and you can see them. When you create an RFI right after the user sent files, tell them the app shows a button under your answer to attach those files to the RFI. Otherwise, when an RFI needs photos, give the user its "Add photos" link.
- Keep answers short and practical, in plain language for people on a jobsite. Use short lists when listing items.
- Each user message ends with a bracketed context line (who is asking, today's date, the project on screen). Use it, but don't repeat it back.
- You only see what the signed-in user is allowed to see; if a tool says permission is denied, explain that plainly.`;

const TOOL_DEFS = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

const month = () => new Date().toISOString().slice(0, 7);
const usageId = () => "aiuse_" + month().replace("-", "");
function costOf(model, u) {
  const p = PRICES[model] || PRICES.default;
  return ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output +
    (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}
async function settings() {
  const s = await db.get(SETTINGS_ID);
  return { access: "admins", capUsd: DEFAULT_CAP_USD, ...(s ? s.data : {}) };
}
async function usage() {
  const u = await db.get(usageId());
  return u ? u.data : { month: month(), costUsd: 0, requests: 0, byUser: {} };
}
const allowed = (ctx, st) => ctx.isAdmin || st.access === "everyone";
const FILE_TYPES = { "image/jpeg": "image", "image/png": "image", "image/gif": "image", "image/webp": "image", "application/pdf": "document" };
const MAX_FILE = 3 * 1024 * 1024;     // keeps the upload request under the hosting limit (~4.5 MB with base64)
const fileSig = (ctx, id) => auth.tag(ctx.user.id + ":" + id);
// Every file referenced in the conversation must carry this user's signature
function checkFiles(ctx, messages, sigs) {
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      const src = c && c.source;
      if (!src) continue;
      if (src.type !== "file" || !["image", "document"].includes(c.type)) throw auth.httpError(400, "Bad attachment in the conversation");
      if (typeof src.file_id !== "string" || !sigs || sigs[src.file_id] !== fileSig(ctx, src.file_id)) throw auth.httpError(403, "An attachment in this chat isn't yours — start a new chat");
    }
  }
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch (e) { return {}; }
}

// ── Equipment schedules → rows (structured output, so the result is always valid JSON)
const EQUIP_TRADES = ["Mechanical", "Plumbing", "Fire Protection", "Electrical", "Other"];
const EQUIP_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: {
    type: "object", additionalProperties: false,
    required: ["tag", "description", "trade", "manufacturer", "model", "quantity", "electrical", "location", "sheet", "notes"],
    properties: {
      tag: { type: "string", description: "Equipment mark / tag exactly as in the schedule, e.g. RTU-1, EF-3, WH-1" },
      description: { type: "string", description: "What it is, e.g. Rooftop unit, Exhaust fan, Gas water heater" },
      trade: { type: "string", enum: EQUIP_TRADES },
      manufacturer: { type: "string" }, model: { type: "string" },
      quantity: { type: "string", description: "Quantity if the schedule gives one, else empty" },
      electrical: { type: "string", description: "Electrical data as written: volts/phase, HP or kW, FLA/MCA/MOCP, disconnect or starter notes" },
      location: { type: "string", description: "Area / floor / room served or located, if given" },
      sheet: { type: "string", description: "Sheet number the schedule is on" },
      notes: { type: "string", description: "Anything an electrical contractor should know (e.g. 'by Div 26', 'VFD furnished by mech'); else empty" }
    } } } }
};
async function readSchedules(ctx, st, b, res) {
  const pid = String(b.projectId || "");
  auth.ensure(db.ID_RE.test(pid) && ctx.can(pid, "submittals", "standard"), "You need Submittals access on this project");
  const files = (Array.isArray(b.files) ? b.files : []).slice(0, 12);
  if (!files.length) throw auth.httpError(400, "Pick at least one sheet");
  const blocks = files.map(f => (/\.pdf$/i.test(String(f.name || "")) ? { type: "document", source: { type: "file", file_id: String(f.fileId || "") }, title: String(f.name).slice(0, 120) }
    : { type: "image", source: { type: "file", file_id: String(f.fileId || "") } }));
  checkFiles(ctx, [{ role: "user", content: blocks }], b.fileSigs || {});
  const used = await usage();
  if (used.costUsd >= st.capUsd) throw auth.httpError(402, `This month's AI limit ($${st.capUsd}) has been reached. A company admin can raise it in the assistant settings.`, "CAP_REACHED");
  // streamed (the SDK requires it for long answers); we only need the final message
  const response = await new Anthropic().messages.stream({
    model: MODEL,
    max_tokens: 32000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: EQUIP_SCHEMA } },
    messages: [{ role: "user", content: [...blocks, { type: "text", text:
      `These are mechanical and plumbing drawing sheets (${files.map(f => String(f.name || "").slice(0, 80)).join(", ")}). Find every equipment schedule on them and list each piece of equipment once (one row per tag; if a row covers several tags like EF-1 thru EF-4, list each tag). ` +
      `We are the electrical contractor and use this list to track submittals and power connections, so copy the electrical data exactly as written. Leave a field empty when the schedule doesn't give it — don't guess. Skip notes, legends and fixture/diffuser schedules that aren't equipment (grilles, registers, plumbing fixtures like sinks and toilets).` }] }]
  }).finalMessage();
  const cost = costOf(response.model, response.usage || {});
  await recordSpend(ctx, cost);
  if (response.stop_reason === "refusal") throw auth.httpError(422, "The AI couldn't read these sheets.");
  const text = response.content.filter(x => x.type === "text").map(x => x.text).join("");
  let items = [];
  try { items = JSON.parse(text).items || []; } catch (e) { throw auth.httpError(502, response.stop_reason === "max_tokens" ? "Too much equipment in one go — pick fewer sheets and try again." : "The AI's answer couldn't be read — try again."); }
  items = items.filter(x => x && (x.tag || x.description)).slice(0, 500);
  return res.status(200).json({ ok: true, items, usage: { costUsd: Math.round(cost * 10000) / 10000 } });
}
// ── A change order / proposal PDF → the fields for a new change order
const CO_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "amount", "submitted", "description", "documentNumber", "isChangeOrder"],
  properties: {
    isChangeOrder: { type: "boolean", description: "false if this document is not a change order, proposal, quote or pricing for extra work" },
    title: { type: "string", description: "Short title of the change, e.g. 'Add 4 receptacles in conference room'" },
    amount: { anyOf: [{ type: "number" }, { type: "null" }], description: "Total price in dollars (negative for a credit); null if not stated" },
    submitted: { type: "string", description: "Date on the document as YYYY-MM-DD, or empty" },
    documentNumber: { type: "string", description: "The CO / proposal / PCO number printed on the document, or empty" },
    description: { type: "string", description: "Scope of work in plain sentences, plus a short price breakdown (labor / material / markup) if the document has one" }
  }
};
async function readChangeOrder(ctx, st, b, res) {
  const pid = String(b.projectId || "");
  auth.ensure(db.ID_RE.test(pid) && ctx.can(pid, "changeorders", "standard"), "You need Change Orders access on this project");
  const f = b.file || {};
  const block = /\.pdf$/i.test(String(f.name || "")) ? { type: "document", source: { type: "file", file_id: String(f.fileId || "") }, title: String(f.name).slice(0, 120) }
    : { type: "image", source: { type: "file", file_id: String(f.fileId || "") } };
  checkFiles(ctx, [{ role: "user", content: [block] }], b.fileSigs || {});
  const used = await usage();
  if (used.costUsd >= st.capUsd) throw auth.httpError(402, `This month's AI limit ($${st.capUsd}) has been reached. A company admin can raise it in the assistant settings.`, "CAP_REACHED");
  const response = await new Anthropic().messages.stream({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: CO_SCHEMA } },
    messages: [{ role: "user", content: [block, { type: "text", text:
      "This document was dropped into the Change Orders log of NetPower Electric (an electrical contractor). Fill in the change order fields from it. Use only what the document says; leave fields empty (or null) when it doesn't say." }] }]
  }).finalMessage();
  const cost = costOf(response.model, response.usage || {});
  await recordSpend(ctx, cost);
  if (response.stop_reason === "refusal") throw auth.httpError(422, "The AI couldn't read this file.");
  let co;
  try { co = JSON.parse(response.content.filter(x => x.type === "text").map(x => x.text).join("")); } catch (e) { throw auth.httpError(502, "The AI's answer couldn't be read — try again."); }
  return res.status(200).json({ ok: true, changeOrder: co, usage: { costUsd: Math.round(cost * 10000) / 10000 } });
}

async function recordSpend(ctx, cost) {
  const fresh = await usage();
  const by = { ...(fresh.byUser || {}) };
  by[ctx.user.id] = { name: ctx.user.data.name, costUsd: ((by[ctx.user.id] || {}).costUsd || 0) + cost, requests: ((by[ctx.user.id] || {}).requests || 0) + 1 };
  const next = { month: month(), costUsd: (fresh.costUsd || 0) + cost, requests: (fresh.requests || 0) + 1, byUser: by, updatedAt: new Date().toISOString() };
  await db.save([{ id: usageId(), type: "aiusage", projectId: "", data: next }], await db.getMany([usageId()]));
  return next;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!db.configured()) throw auth.httpError(503, "Database is not configured", "NOT_CONFIGURED");
    const ctx = await auth.requireContext(req);
    const st = await settings();

    if (req.method === "GET") {
      const u = await usage();
      return res.status(200).json({ ok: true, allowed: allowed(ctx, st) && !!process.env.ANTHROPIC_API_KEY, configured: !!process.env.ANTHROPIC_API_KEY,
        access: st.access, capUsd: st.capUsd, monthCostUsd: Math.round(u.costUsd * 100) / 100, isAdmin: ctx.isAdmin });
    }
    if (req.method !== "POST") throw auth.httpError(405, "Method not allowed");
    const b = body(req);

    if (req.query && req.query.action === "settings") {
      auth.ensure(ctx.isAdmin, "Only company admins can change assistant settings");
      const capUsd = Math.max(0, Math.min(10000, Number(b.capUsd)));
      if (!Number.isFinite(capUsd)) throw auth.httpError(400, "Enter a monthly limit in dollars");
      const access = b.access === "everyone" ? "everyone" : "admins";
      await db.save([{ id: SETTINGS_ID, type: "aisetting", projectId: "", data: { access, capUsd, updatedBy: ctx.user.data.name, updatedAt: new Date().toISOString() } }], await db.getMany([SETTINGS_ID]));
      return res.status(200).json({ ok: true, access, capUsd });
    }

    auth.ensure(allowed(ctx, st), "The assistant is only available to company admins right now");
    if (!process.env.ANTHROPIC_API_KEY) throw auth.httpError(503, "The assistant isn't set up yet: ANTHROPIC_API_KEY is missing on the server.", "NOT_CONFIGURED");

    if (req.query && req.query.action === "upload") {
      const type = String(b.type || ""), kind = FILE_TYPES[type];
      if (!kind) throw auth.httpError(400, "Only photos (JPG, PNG, GIF, WebP) and PDFs can be sent to the assistant");
      const buf = Buffer.from(String(b.data || ""), "base64");
      if (!buf.length) throw auth.httpError(400, "The file is empty");
      if (buf.length > MAX_FILE) throw auth.httpError(413, "That file is too big for the assistant (3 MB max). Try a smaller PDF or a photo.");
      const name = String(b.name || "file").replace(/[<>:"|?*\\/\x00-\x1f]/g, "_").slice(0, 120) || "file";
      const up = await new Anthropic().files.upload({ file: await toFile(buf, name, { type }), expires_in_seconds: 7 * 24 * 3600 });
      return res.status(200).json({ ok: true, fileId: up.id, kind, name, sig: fileSig(ctx, up.id) });
    }

    if (req.query && req.query.action === "schedules") return await readSchedules(ctx, st, b, res);
    if (req.query && req.query.action === "changeorder") return await readChangeOrder(ctx, st, b, res);

    const text = String(b.text || "").trim().slice(0, 4000);
    const files = (Array.isArray(b.files) ? b.files : []).slice(0, 10);
    if (!text && !files.length) throw auth.httpError(400, "Type a question");
    const history = Array.isArray(b.messages) ? b.messages : [];
    if (JSON.stringify(history).length > 800000) throw auth.httpError(413, "This conversation is too long — start a new chat");
    if (history.some(m => !m || !["user", "assistant"].includes(m.role))) throw auth.httpError(400, "Bad conversation history");
    const sigs = b.fileSigs && typeof b.fileSigs === "object" ? b.fileSigs : {};
    const fileBlocks = files.map(f => {
      const kind = f && f.kind === "document" ? "document" : "image";
      return kind === "document" ? { type: "document", source: { type: "file", file_id: String(f.fileId || "") }, title: String(f.name || "").slice(0, 120) || undefined }
        : { type: "image", source: { type: "file", file_id: String(f.fileId || "") } };
    });
    checkFiles(ctx, [...history, { role: "user", content: fileBlocks }], sigs);

    const used = await usage();
    if (used.costUsd >= st.capUsd) throw auth.httpError(402, `This month's assistant limit ($${st.capUsd}) has been reached. A company admin can raise it in the assistant settings.`, "CAP_REACHED");

    // Context goes in the user message (append-only), so the system prompt stays identical across requests
    let where = "";
    if (b.projectId && db.ID_RE.test(b.projectId) && ctx.isMember(b.projectId)) {
      const p = await db.get(b.projectId);
      if (p && p.type === "project") where = `; project on screen: "${p.data.name}"`;
    }
    const ask = `${text || "(see the attached files)"}${files.length ? `\n\n[Attached: ${files.map(f => String(f.name || "file").slice(0, 120)).join(", ")}]` : ""}\n\n[Context: asked by ${ctx.user.data.name}${ctx.isAdmin ? " (company admin)" : ""}; today is ${new Date().toISOString().slice(0, 10)}${where}]`;
    const messages = [...history, { role: "user", content: fileBlocks.length ? [...fileBlocks, { type: "text", text: ask }] : ask }];

    const client = new Anthropic();
    let cost = 0, reply = "", stopped = "";
    const actions = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",               // if Claude declines on safety grounds, the API retries on a fallback model
        output_config: { effort: "low" },   // chat: quick answers; tool use still works
        cache_control: { type: "ephemeral" },
        system: SYSTEM,
        tools: TOOL_DEFS,
        messages
      });
      cost += costOf(response.model, response.usage || {});
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "refusal") { reply = "Sorry — I can't help with that request."; stopped = "refusal"; break; }
      if (response.stop_reason === "pause_turn") continue;
      const calls = response.content.filter(x => x.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !calls.length) {
        reply = response.content.filter(x => x.type === "text").map(x => x.text).join("\n").trim();
        if (response.stop_reason === "max_tokens") reply += "\n\n(Answer cut short — ask me to continue.)";
        break;
      }
      const results = [];
      for (const call of calls) {
        try {
          const out = await callTool(ctx, req, call.name, call.input);
          results.push({ type: "tool_result", tool_use_id: call.id, content: out });
          if (/^(create_|respond_|add_)/.test(call.name)) {
            const link = /\/pm#\/p\/([A-Za-z0-9_-]+)\/(rfis|punch|tasks)\/([A-Za-z0-9_-]+)/.exec(out) || [];
            actions.push({ tool: call.name, text: out.split("\n")[0], projectId: link[1] || "", recordId: link[3] || "" });
          }
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: e.userFacing ? e.message : "Error: " + e.message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
      if (used.costUsd + cost >= st.capUsd) { reply = "I stopped because this month's assistant spending limit was reached."; stopped = "cap"; break; }
      if (step === MAX_STEPS - 1) { reply = "That took more steps than I'm allowed in one go — ask me to continue."; stopped = "steps"; }
    }

    // Record spend (read-modify-write; small races only make the total slightly low)
    const next = await recordSpend(ctx, cost);

    return res.status(200).json({ ok: true, messages, reply, actions, stopped,
      usage: { costUsd: Math.round(cost * 10000) / 10000, monthCostUsd: Math.round(next.costUsd * 100) / 100, capUsd: st.capUsd } });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const msg = err.status === 429 ? "The AI service is busy — try again in a minute." : err.status === 401 ? "The AI service rejected the server's API key." : "The AI service had a problem (" + err.status + "). Try again.";
      return res.status(502).json({ ok: false, error: msg });
    }
    auth.sendError(res, err);
  }
}
